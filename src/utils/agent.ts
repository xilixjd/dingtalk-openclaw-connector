/**
 * Agent 相关工具函数
 *
 * 提供 Agent 配置解析、工作空间路径解析等功能
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";

type AgentConfigEntry = {
  id?: string;
  workspace?: string;
  default?: boolean;
};

function isDynamicDingtalkAgentId(agentId: string): boolean {
  return /^dingtalk-[a-z0-9_-]+-(dm|group)-[a-z0-9_-]+$/.test(agentId);
}

function normalizeAgentId(agentId: string): string {
  const normalized = String(agentId ?? "").trim().toLowerCase();
  return normalized || "main";
}

function resolveStateDir(): string {
  const stateOverride =
    process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveUserPath(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    return normalized;
  }
  return normalized.startsWith("~")
    ? path.join(os.homedir(), normalized.slice(1))
    : normalized;
}

function listAgentEntries(cfg: ClawdbotConfig): AgentConfigEntry[] {
  const list = (cfg as { agents?: { list?: AgentConfigEntry[] } })?.agents?.list;
  return Array.isArray(list) ? list : [];
}

function resolveConfiguredWorkspace(cfg: ClawdbotConfig, agentId: string): string | undefined {
  const normalizedId = normalizeAgentId(agentId);
  const agentConfig = listAgentEntries(cfg).find(
    (entry) => normalizeAgentId(entry?.id ?? "") === normalizedId,
  );
  const configuredWorkspace =
    typeof agentConfig?.workspace === "string" ? agentConfig.workspace.trim() : "";
  return configuredWorkspace ? resolveUserPath(configuredWorkspace) : undefined;
}

function resolveDefaultAgentId(cfg: ClawdbotConfig): string {
  const configuredDefault =
    typeof (cfg as { defaultAgent?: string })?.defaultAgent === "string"
      ? normalizeAgentId((cfg as { defaultAgent?: string }).defaultAgent!)
      : "";
  if (configuredDefault) {
    return configuredDefault;
  }

  const agents = listAgentEntries(cfg);
  const explicitDefault = agents.find(
    (entry) => entry?.default && typeof entry?.id === "string" && entry.id.trim(),
  );
  if (explicitDefault?.id) {
    return normalizeAgentId(explicitDefault.id);
  }

  if (agents[0]?.id) {
    return normalizeAgentId(agents[0].id);
  }

  return "main";
}

/**
 * 解析 Agent 工作空间路径
 *
 * 参考 OpenClaw Core 的 resolveAgentWorkspaceDir 实现逻辑：
 * 1. 优先从 agents.list 中查找用户配置的 workspace
 * 2. 钉钉 dynamicAgents 始终落到独立的 workspace-<agentId>
 * 3. 默认 Agent 优先使用 agents.defaults.workspace
 * 4. 非默认 Agent 在配置了 agents.defaults.workspace 时，会落到该目录下的子目录
 * 5. 否则回退到 ~/.openclaw/workspace(-{agentId})
 * 
 * @param cfg - OpenClaw 配置对象
 * @param agentId - Agent ID
 * @returns Agent 工作空间的绝对路径
 *
 * @example
 * ```typescript
 * // 用户自定义工作空间
 * const cfg = {
 *   agents: {
 *     list: [{ id: 'bot1', workspace: '~/my-workspace' }]
 *   }
 * };
 * resolveAgentWorkspaceDir(cfg, 'bot1'); // => '/Users/xxx/my-workspace'
 * 
 * // 默认 Agent
 * resolveAgentWorkspaceDir(cfg, 'main'); // => '/Users/xxx/.openclaw/workspace'
 * 
 * // 其他 Agent
 * resolveAgentWorkspaceDir(cfg, 'bot2'); // => '/Users/xxx/.openclaw/workspace-bot2'
 * ```
 */
export function resolveAgentWorkspaceDir(
  cfg: ClawdbotConfig,
  agentId: string,
): string {
  const normalizedId = normalizeAgentId(agentId);
  const configuredWorkspace = resolveConfiguredWorkspace(cfg, normalizedId);
  if (configuredWorkspace) {
    return configuredWorkspace;
  }

  if (isDynamicDingtalkAgentId(normalizedId)) {
    return path.join(resolveStateDir(), `workspace-${normalizedId}`);
  }

  const defaultAgentId = resolveDefaultAgentId(cfg);
  const defaultWorkspace =
    typeof (cfg as { agents?: { defaults?: { workspace?: string } } })?.agents?.defaults
      ?.workspace === "string"
      ? (cfg as { agents?: { defaults?: { workspace?: string } } }).agents!.defaults!.workspace!
          .trim()
      : "";

  if (normalizedId === defaultAgentId) {
    if (defaultWorkspace) {
      return resolveUserPath(defaultWorkspace);
    }
    return path.join(resolveStateDir(), "workspace");
  }

  if (defaultWorkspace) {
    return path.join(resolveUserPath(defaultWorkspace), normalizedId);
  }

  return path.join(resolveStateDir(), `workspace-${normalizedId}`);
}
