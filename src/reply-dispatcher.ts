import type {
  ClawdbotConfig,
  RuntimeEnv,
  ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
} from "openclaw/plugin-sdk";
import { resolveDingtalkAccount } from "./accounts.js";
import { getDingtalkRuntime } from "./runtime.js";
import type { DingtalkConfig } from "./types.js";
import {
  createAICardForTarget,
  streamAICard,
  finishAICard,
  sendMessage,
  type AICardTarget,
  type AICardInstance,
} from "./messaging.js";
import {
  processLocalImages,
  processVideoMarkers,
  processAudioMarkers,
  processFileMarkers,
} from "./media.js";
import { getAccessToken, getOapiAccessToken } from "./utils.js";

export type CreateDingtalkReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  conversationId: string;
  senderId: string;
  isDirect: boolean;
  accountId?: string;
  messageCreateTimeMs?: number;
  sessionWebhook: string;
};

export function createDingtalkReplyDispatcher(params: CreateDingtalkReplyDispatcherParams) {
  const core = getDingtalkRuntime();
  const {
    cfg,
    agentId,
    conversationId,
    senderId,
    isDirect,
    accountId,
    sessionWebhook,
  } = params;

  const account = resolveDingtalkAccount({ cfg, accountId });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: "dingtalk-connector",
    accountId,
  });

  // AI Card 状态管理
  let currentCardTarget: AICardTarget | null = null;
  let accumulatedText = "";
  const deliveredFinalTexts = new Set<string>();

  // 打字指示器回调（钉钉暂不支持，预留接口）
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      // 钉钉暂不支持打字指示器
    },
    stop: async () => {
      // 钉钉暂不支持打字指示器
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "dingtalk-connector",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "dingtalk-connector",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(
    cfg,
    "dingtalk-connector",
    accountId,
    { fallbackLimit: 4000 }
  );
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "dingtalk-connector");

  // 流式 AI Card 支持
  const streamingEnabled = account.config?.streaming !== false;

  const startStreaming = async () => {
    if (!streamingEnabled || currentCardTarget) {
      return;
    }

    try {
      const target: AICardTarget = isDirect
        ? { type: 'user', userId: senderId }
        : { type: 'group', openConversationId: conversationId };
      
      currentCardTarget = await createAICardForTarget(
        account.config as DingtalkConfig,
        target,
        params.runtime.log
      );
      accumulatedText = "";
    } catch (error) {
      params.runtime.error?.(
        `dingtalk[${account.accountId}]: streaming start failed: ${String(error)}`
      );
      currentCardTarget = null;
    }
  };

  const closeStreaming = async () => {
    if (!currentCardTarget) {
      return;
    }

    try {
      // 处理媒体标记
      let finalText = accumulatedText;
      
      // 获取 oapiToken 用于媒体处理
      const oapiToken = await getOapiAccessToken(account.config as DingtalkConfig);
      
      if (oapiToken) {
        // 处理本地图片
        finalText = await processLocalImages(finalText, oapiToken, params.runtime.log);
        
        // 处理视频、音频、文件标记
        const target: AICardTarget = isDirect
          ? { type: 'user', userId: senderId }
          : { type: 'group', openConversationId: conversationId };
        
        finalText = await processVideoMarkers(
          finalText,
          '',
          account.config as DingtalkConfig,
          oapiToken,
          params.runtime.log,
          false,
          target
        );
        finalText = await processAudioMarkers(
          finalText,
          '',
          account.config as DingtalkConfig,
          oapiToken,
          params.runtime.log,
          false,
          target
        );
        finalText = await processFileMarkers(
          finalText,
          '',
          account.config as DingtalkConfig,
          oapiToken,
          params.runtime.log,
          false,
          target
        );
      }

      await finishAICard(
        currentCardTarget as AICardInstance,
        finalText,
        params.runtime.log
      );
    } catch (error) {
      params.runtime.error?.(
        `dingtalk[${account.accountId}]: streaming close failed: ${String(error)}`
      );
    } finally {
      currentCardTarget = null;
      accumulatedText = "";
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        deliveredFinalTexts.clear();
        if (streamingEnabled) {
          void startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        const hasText = Boolean(text.trim());
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!shouldDeliverText) {
          return;
        }

        // 流式模式：使用 AI Card
        if (info?.kind === "block" && streamingEnabled) {
          if (!currentCardTarget) {
            await startStreaming();
          }
          if (currentCardTarget) {
            accumulatedText += text;
            await streamAICard(
              currentCardTarget as AICardInstance,
              accumulatedText,
              false,
              params.runtime.log
            );
          }
          return;
        }

        if (info?.kind === "final" && streamingEnabled && currentCardTarget) {
          accumulatedText = text;
          await closeStreaming();
          deliveredFinalTexts.add(text);
          return;
        }

        // 非流式模式：使用普通消息发送
        if (info?.kind === "final" && !streamingEnabled) {
          try {
            // 分块发送（如果文本过长）
            for (const chunk of core.channel.text.chunkTextWithMode(
              text,
              textChunkLimit,
              chunkMode
            )) {
              await sendMessage(
                account.config as DingtalkConfig,
                sessionWebhook,
                chunk,
                {
                  useMarkdown: true,
                  log: params.runtime.log,
                }
              );
            }
            deliveredFinalTexts.add(text);
          } catch (error) {
            params.runtime.error?.(
              `dingtalk[${account.accountId}]: non-streaming delivery failed: ${String(error)}`
            );
          }
          return;
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `dingtalk[${account.accountId}] ${info.kind} reply failed: ${String(error)}`
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            if (currentCardTarget) {
              accumulatedText = payload.text;
              void streamAICard(
                currentCardTarget as AICardInstance,
                accumulatedText,
                false,
                params.runtime.log
              );
            }
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
