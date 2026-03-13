/**
 * 钉钉插件工具函数
 */

import type { DingtalkConfig, ResolvedDingtalkAccount } from './types.js';

// ============ 常量 ============

/** 默认账号 ID，用于标记单账号模式（无 accounts 配置）时的内部标识 */
export const DEFAULT_ACCOUNT_ID = '__default__';

/** 新会话触发命令 */
export const NEW_SESSION_COMMANDS = ['/new', '/reset', '/clear', '新会话', '重新开始', '清空对话'];

/** 钉钉 API 常量 */
export const DINGTALK_API = 'https://api.dingtalk.com';
export const DINGTALK_OAPI = 'https://oapi.dingtalk.com';

// ============ 会话管理 ============

/** OpenClaw 标准会话上下文 */
export interface SessionContext {
  channel: 'dingtalk-connector';
  accountId: string;
  chatType: 'direct' | 'group';
  peerId: string;
  conversationId?: string;
  senderName?: string;
  groupSubject?: string;
}

/**
 * 构建 OpenClaw 标准会话上下文
 * 遵循 OpenClaw session.dmScope 机制，让 Gateway 根据配置自动处理会话隔离
 */
export function buildSessionContext(params: {
  accountId: string;
  senderId: string;
  senderName?: string;
  conversationType: string;
  conversationId?: string;
  groupSubject?: string;
  separateSessionByConversation?: boolean;
  groupSessionScope?: 'group' | 'group_sender';
}): SessionContext {
  const {
    accountId,
    senderId,
    senderName,
    conversationType,
    conversationId,
    groupSubject,
    separateSessionByConversation,
    groupSessionScope,
  } = params;
  const isDirect = conversationType === '1';

  // separateSessionByConversation=false 时，不区分单聊/群聊，按用户维度维护 session
  if (separateSessionByConversation === false) {
    return {
      channel: 'dingtalk-connector',
      accountId,
      chatType: isDirect ? 'direct' : 'group',
      peerId: senderId, // 只用 senderId，不区分会话
      senderName,
    };
  }

  // 以下是 separateSessionByConversation=true（默认）的逻辑
  if (isDirect) {
    // 单聊：peerId 为发送者 ID，由 OpenClaw Gateway 根据 dmScope 配置处理
    return {
      channel: 'dingtalk-connector',
      accountId,
      chatType: 'direct',
      peerId: senderId,
      senderName,
    };
  }

  // 群聊：根据 groupSessionScope 配置决定会话隔离策略
  if (groupSessionScope === 'group_sender') {
    // 群内每个用户独立会话
    return {
      channel: 'dingtalk-connector',
      accountId,
      chatType: 'group',
      peerId: `${conversationId}:${senderId}`,
      conversationId,
      senderName,
      groupSubject,
    };
  }

  // 默认：整个群共享一个会话
  return {
    channel: 'dingtalk-connector',
    accountId,
    chatType: 'group',
    peerId: conversationId || senderId,
    conversationId,
    senderName,
    groupSubject,
  };
}

/**
 * 检查消息是否是新会话命令
 */
export function normalizeSlashCommand(text: string): string {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (NEW_SESSION_COMMANDS.some((cmd) => lower === cmd.toLowerCase())) {
    return '/new';
  }
  return text;
}

// ============ Access Token 缓存 ============

let accessToken: string | null = null;
let accessTokenExpiry = 0;

/**
 * 获取钉钉 Access Token（新版 API）
 */
export async function getAccessToken(config: DingtalkConfig): Promise<string> {
  const now = Date.now();
  if (accessToken && accessTokenExpiry > now + 60_000) {
    return accessToken;
  }

  const axios = (await import('axios')).default;
  const response = await axios.post(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
    appKey: config.clientId,
    appSecret: config.clientSecret,
  });

  accessToken = response.data.accessToken;
  accessTokenExpiry = now + response.data.expireIn * 1000;
  return accessToken!;
}

/**
 * 获取钉钉 OAPI Access Token（旧版 API，用于媒体上传等）
 */
export async function getOapiAccessToken(config: DingtalkConfig): Promise<string | null> {
  try {
    const axios = (await import('axios')).default;
    const resp = await axios.get(`${DINGTALK_OAPI}/gettoken`, {
      params: { appkey: config.clientId, appsecret: config.clientSecret },
    });
    if (resp.data?.errcode === 0) return resp.data.access_token;
    return null;
  } catch {
    return null;
  }
}

// ============ 用户 ID 转换 ============

/** staffId → unionId 缓存 */
const unionIdCache = new Map<string, string>();

/**
 * 通过 oapi 旧版接口将 staffId 转换为 unionId
 */
export async function getUnionId(
  staffId: string,
  config: DingtalkConfig,
  log?: any,
): Promise<string | null> {
  const cached = unionIdCache.get(staffId);
  if (cached) return cached;

  try {
    const token = await getOapiAccessToken(config);
    if (!token) {
      log?.error?.('[DingTalk] getUnionId: 无法获取 oapi access_token');
      return null;
    }
    const axios = (await import('axios')).default;
    const resp = await axios.get(`${DINGTALK_OAPI}/user/get`, {
      params: { access_token: token, userid: staffId },
      timeout: 10_000,
    });
    const unionId = resp.data?.unionid;
    if (unionId) {
      unionIdCache.set(staffId, unionId);
      log?.info?.(`[DingTalk] getUnionId: ${staffId} → ${unionId}`);
      return unionId;
    }
    log?.error?.(`[DingTalk] getUnionId: 响应中无 unionid 字段: ${JSON.stringify(resp.data)}`);
    return null;
  } catch (err: any) {
    log?.error?.(`[DingTalk] getUnionId 失败: ${err.message}`);
    return null;
  }
}

// ============ 消息去重 ============

/** 消息去重缓存 Map<messageId, timestamp> - 防止同一消息被重复处理 */
const processedMessages = new Map<string, number>();

/** 消息去重缓存过期时间（5分钟） */
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000;

/**
 * 清理过期的消息去重缓存
 */
export function cleanupProcessedMessages(): void {
  const now = Date.now();
  for (const [msgId, timestamp] of processedMessages.entries()) {
    if (now - timestamp > MESSAGE_DEDUP_TTL) {
      processedMessages.delete(msgId);
    }
  }
}

/**
 * 检查消息是否已处理过（去重）
 */
export function isMessageProcessed(messageId: string): boolean {
  if (!messageId) return false;
  return processedMessages.has(messageId);
}

/**
 * 标记消息为已处理
 */
export function markMessageProcessed(messageId: string): void {
  if (!messageId) return;
  processedMessages.set(messageId, Date.now());
  // 定期清理（每处理100条消息清理一次）
  if (processedMessages.size >= 100) {
    cleanupProcessedMessages();
  }
}

// ============ 配置工具 ============

/**
 * 获取钉钉配置
 */
export function getDingtalkConfig(cfg: any): DingtalkConfig {
  return (cfg?.channels as any)?.['dingtalk-connector'] || {};
}

/**
 * 检查是否已配置
 */
export function isDingtalkConfigured(cfg: any): boolean {
  const config = getDingtalkConfig(cfg);
  return Boolean(config.clientId && config.clientSecret);
}

/**
 * 构建媒体系统提示词
 */
export function buildMediaSystemPrompt(): string {
  return `## 钉钉图片和文件显示规则

你正在钉钉中与用户对话。

### 一、图片显示

显示图片时，直接使用本地文件路径，系统会自动上传处理。

**正确方式**：
\`\`\`markdown
![描述](file:///path/to/image.jpg)
![描述](/tmp/screenshot.png)
![描述](/Users/xxx/photo.jpg)
\`\`\`

**禁止**：
- 不要自己执行 curl 上传
- 不要猜测或构造 URL
- **不要对路径进行转义（如使用反斜杠 \\ ）**

直接输出本地路径即可，系统会自动上传到钉钉。

### 二、视频分享

**何时分享视频**：
- ✅ 用户明确要求**分享、发送、上传**视频时
- ❌ 仅生成视频保存到本地时，**不需要**分享

**视频标记格式**：
当需要分享视频时，在回复**末尾**添加：

\`\`\`
[DINGTALK_VIDEO]{"path":"<本地视频路径>"}[/DINGTALK_VIDEO]
\`\`\`

**支持格式**：mp4（最大 20MB）

**重要**：
- 视频大小不得超过 20MB，超过限制时告知用户
- 仅支持 mp4 格式
- 系统会自动提取视频时长、分辨率并生成封面

### 三、音频分享

**何时分享音频**：
- ✅ 用户明确要求**分享、发送、上传**音频/语音文件时
- ❌ 仅生成音频保存到本地时，**不需要**分享

**音频标记格式**：
当需要分享音频时，在回复**末尾**添加：

\`\`\`
[DINGTALK_AUDIO]{"path":"<本地音频路径>"}[/DINGTALK_AUDIO]
\`\`\`

**支持格式**：ogg、amr（最大 20MB）

**重要**：
- 音频大小不得超过 20MB，超过限制时告知用户
- 系统会自动提取音频时长

### 四、文件分享

**何时分享文件**：
- ✅ 用户明确要求**分享、发送、上传**文件时
- ❌ 仅生成文件保存到本地时，**不需要**分享

**文件标记格式**：
当需要分享文件时，在回复**末尾**添加：

\`\`\`
[DINGTALK_FILE]{"path":"<本地文件路径>","fileName":"<文件名>","fileType":"<扩展名>"}[/DINGTALK_FILE]
\`\`\`

**支持的文件类型**：几乎所有常见格式

**重要**：文件大小不得超过 20MB，超过限制时告知用户文件过大。`;
}
