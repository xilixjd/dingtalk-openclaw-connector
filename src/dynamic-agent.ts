import type { ClawdbotConfig } from "openclaw/plugin-sdk";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAgentWorkspaceDir } from "./utils/agent.ts";

export type DynamicAgentChatType = "dm" | "group";

export interface DynamicAgentConfig {
  enabled: boolean;
  dmCreateAgent: boolean;
  groupEnabled: boolean;
  adminUsers: string[];
  workspaceSeed: boolean;
}

export function getDynamicAgentConfig(config: ClawdbotConfig): DynamicAgentConfig {
  const dynamicAgents = (config as {
    channels?: {
      "dingtalk-connector"?: {
        dynamicAgents?: Partial<DynamicAgentConfig>;
      };
    };
  })?.channels?.["dingtalk-connector"]?.dynamicAgents;

  return {
    enabled: dynamicAgents?.enabled ?? false,
    dmCreateAgent: dynamicAgents?.dmCreateAgent ?? true,
    groupEnabled: dynamicAgents?.groupEnabled ?? true,
    adminUsers: dynamicAgents?.adminUsers ?? [],
    workspaceSeed: dynamicAgents?.workspaceSeed ?? true,
  };
}

function sanitizeDynamicIdPart(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

export function generateAgentId(
  chatType: DynamicAgentChatType,
  peerId: string,
  accountId?: string,
): string {
  const sanitizedPeer = sanitizeDynamicIdPart(peerId) || "unknown";
  const sanitizedAccountId = sanitizeDynamicIdPart(accountId ?? "default") || "default";
  return `dingtalk-${sanitizedAccountId}-${chatType}-${sanitizedPeer}`;
}

export function shouldUseDynamicAgent(params: {
  chatType: DynamicAgentChatType;
  senderId: string;
  config: ClawdbotConfig;
}): boolean {
  const { chatType, senderId, config } = params;
  const dynamicConfig = getDynamicAgentConfig(config);

  if (!dynamicConfig.enabled) {
    return false;
  }

  const sender = String(senderId).trim().toLowerCase();
  const isAdmin = dynamicConfig.adminUsers.some(
    (admin) => String(admin).trim().toLowerCase() === sender,
  );

  if (isAdmin) {
    return false;
  }

  if (chatType === "group") {
    return dynamicConfig.groupEnabled;
  }
  return dynamicConfig.dmCreateAgent;
}

const ensuredDynamicAgentIds = new Set<string>();
let ensureDynamicAgentWriteQueue: Promise<void> = Promise.resolve();

function upsertDynamicAgentEntry(
  cfg: Record<string, unknown>,
  agentId: string,
  workspaceDir: string,
): boolean {
  if (!cfg.agents || typeof cfg.agents !== "object") {
    cfg.agents = {};
  }

  const agentsObj = cfg.agents as Record<string, unknown>;
  const currentList: Array<{ id?: string; workspace?: string }> = Array.isArray(agentsObj.list)
    ? (agentsObj.list as Array<{ id?: string; workspace?: string }>)
    : [];

  let changed = false;
  const nextList = [...currentList];

  if (nextList.length === 0) {
    nextList.push({ id: "main" });
    changed = true;
  }

  const existingIndex = nextList.findIndex(
    (entry) => entry?.id?.trim().toLowerCase() === agentId.toLowerCase(),
  );

  if (existingIndex === -1) {
    nextList.push({ id: agentId, workspace: workspaceDir });
    changed = true;
  } else {
    const existingEntry = nextList[existingIndex];
    if (!existingEntry.workspace?.trim()) {
      nextList[existingIndex] = { ...existingEntry, workspace: workspaceDir };
      changed = true;
    }
  }

  if (changed) {
    agentsObj.list = nextList;
  }

  return changed;
}

export function ensureDynamicAgentConfigured(
  agentId: string,
  config: ClawdbotConfig,
): boolean {
  const normalizedId = String(agentId).trim().toLowerCase();
  if (!normalizedId || !config || typeof config !== "object") {
    return false;
  }

  const workspaceDir = resolveDynamicAgentWorkspaceDir(normalizedId);
  return upsertDynamicAgentEntry(
    config as unknown as Record<string, unknown>,
    normalizedId,
    workspaceDir,
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureDynamicAgentListed(agentId: string, runtime: any): Promise<void> {
  const normalizedId = String(agentId).trim().toLowerCase();
  if (!normalizedId) return;
  if (ensuredDynamicAgentIds.has(normalizedId)) return;

  const configRuntime = runtime?.config;
  if (!configRuntime?.loadConfig || !configRuntime?.writeConfigFile) return;

  ensureDynamicAgentWriteQueue = ensureDynamicAgentWriteQueue
    .then(async () => {
      if (ensuredDynamicAgentIds.has(normalizedId)) return;

      const latestConfig = configRuntime.loadConfig!();
      if (!latestConfig || typeof latestConfig !== "object") return;

      const workspaceDir = resolveDynamicAgentWorkspaceDir(normalizedId);
      const changed = upsertDynamicAgentEntry(
        latestConfig as Record<string, unknown>,
        normalizedId,
        workspaceDir,
      );

      if (changed) {
        await configRuntime.writeConfigFile!(latestConfig as unknown);
      }

      ensuredDynamicAgentIds.add(normalizedId);
    })
    .catch((err) => {
      console.warn(`[dingtalk-dynamic-agent] failed to list agent: ${normalizedId}`, err);
    });

  await ensureDynamicAgentWriteQueue;
}

const dynamicSkillsRootWatchers = new Map<string, fs.FSWatcher>();
const dynamicSkillsChildWatchers = new Map<string, Map<string, fs.FSWatcher>>();
const dynamicSkillsWorkspaceDirs = new Map<string, string>();

type DynamicSkillDelta = {
  skillName: string;
  changeType: "added" | "updated" | "removed";
  skillFilePath: string;
};

type DynamicSkillsDeltaState = {
  changes: Map<string, DynamicSkillDelta>;
};

const dynamicSkillsDeltaState = new Map<string, DynamicSkillsDeltaState>();

const DYNAMIC_WORKSPACE_STANDARD_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];

function resolveStateDir(): string {
  const stateOverride =
    process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveDynamicAgentWorkspaceDir(agentId: string): string {
  const normalizedId = String(agentId).trim().toLowerCase() || "main";
  return path.join(resolveStateDir(), `workspace-${normalizedId}`);
}

function recordDynamicSkillDelta(
  agentId: string,
  skillName: string,
  changeType: "added" | "updated" | "removed",
  skillFilePath: string,
): void {
  const existing = dynamicSkillsDeltaState.get(agentId) ?? {
    changes: new Map<string, DynamicSkillDelta>(),
  };
  existing.changes.set(skillName, { skillName, changeType, skillFilePath });
  dynamicSkillsDeltaState.set(agentId, existing);
}

function noteDynamicSkillFileChange(agentId: string, skillDir: string): void {
  const skillName = path.basename(skillDir);
  const skillFilePath = path.join(skillDir, "SKILL.md");
  const exists = fs.existsSync(skillFilePath);
  recordDynamicSkillDelta(
    agentId,
    skillName,
    exists ? "updated" : "removed",
    skillFilePath,
  );
}

export function consumeDynamicSkillsDeltaNote(agentId: string): string | undefined {
  const state = dynamicSkillsDeltaState.get(agentId);
  if (!state || state.changes.size === 0) {
    return undefined;
  }

  const lines = [
    "[Runtime note: workspace skills changed]",
    "The following workspace skills changed recently. Any earlier conversation about them may be stale.",
  ];

  for (const change of state.changes.values()) {
    lines.push(`- ${change.changeType}: ${change.skillName} (${change.skillFilePath})`);
  }

  lines.push(
    "If the current task may use one of these skills, re-read the listed SKILL.md before relying on it.",
  );

  dynamicSkillsDeltaState.delete(agentId);

  return lines.join("\n");
}

export function buildDynamicAgentInboundBody(params: {
  agentId: string;
  commandBody: string;
  isCommand: boolean;
}): {
  commandBody: string;
  modelInputBody: string;
} {
  const { agentId, commandBody, isCommand } = params;
  if (isCommand) {
    return {
      commandBody,
      modelInputBody: commandBody,
    };
  }

  const skillsDeltaNote = consumeDynamicSkillsDeltaNote(agentId);
  if (!skillsDeltaNote) {
    return {
      commandBody,
      modelInputBody: commandBody,
    };
  }

  return {
    commandBody,
    modelInputBody: [skillsDeltaNote, "", commandBody].join("\n"),
  };
}

function watchSkillChildDir(agentId: string, childDir: string): void {
  let watchers = dynamicSkillsChildWatchers.get(agentId);
  if (!watchers) {
    watchers = new Map<string, fs.FSWatcher>();
    dynamicSkillsChildWatchers.set(agentId, watchers);
  }

  if (watchers.has(childDir) || !fs.existsSync(childDir)) {
    return;
  }

  try {
    const watcher = fs.watch(childDir, (_eventType, fileName) => {
      if (!fileName || String(fileName) === "SKILL.md") {
        noteDynamicSkillFileChange(agentId, childDir);
      }
    });

    watcher.on("error", (err) => {
      console.error(`[dingtalk-skills-watch] child watcher error for ${agentId}: ${err}`);
    });

    watchers.set(childDir, watcher);
  } catch (err) {
    console.error(`[dingtalk-skills-watch] failed to watch ${childDir}: ${err}`);
  }
}

function syncDynamicSkillsChildWatchers(
  agentId: string,
  skillsDir: string,
  includeAdds: boolean,
): void {
  const active = dynamicSkillsChildWatchers.get(agentId) ?? new Map<string, fs.FSWatcher>();
  const nextDirs = new Set<string>();

  if (fs.existsSync(skillsDir)) {
    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const childDir = path.join(skillsDir, entry.name);
        nextDirs.add(childDir);
        if (!active.has(childDir)) {
          watchSkillChildDir(agentId, childDir);
          const skillFilePath = path.join(childDir, "SKILL.md");
          if (includeAdds && fs.existsSync(skillFilePath)) {
            recordDynamicSkillDelta(agentId, entry.name, "added", skillFilePath);
          }
        }
      }
    } catch (err) {
      console.error(`[dingtalk-skills-watch] failed to scan ${skillsDir}: ${err}`);
    }
  }

  for (const [childDir, watcher] of active) {
    if (nextDirs.has(childDir)) {
      continue;
    }

    watcher.close();
    active.delete(childDir);
    recordDynamicSkillDelta(
      agentId,
      path.basename(childDir),
      "removed",
      path.join(childDir, "SKILL.md"),
    );
  }

  dynamicSkillsChildWatchers.set(agentId, active);
}

function ensureDynamicSkillsWatcher(agentId: string, workspaceDir: string): void {
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  const existingWorkspaceDir = dynamicSkillsWorkspaceDirs.get(agentId);

  if (existingWorkspaceDir && existingWorkspaceDir !== normalizedWorkspaceDir) {
    dynamicSkillsRootWatchers.get(agentId)?.close();
    dynamicSkillsRootWatchers.delete(agentId);

    const childWatchers = dynamicSkillsChildWatchers.get(agentId);
    if (childWatchers) {
      for (const watcher of childWatchers.values()) {
        watcher.close();
      }
      dynamicSkillsChildWatchers.delete(agentId);
    }
  }

  dynamicSkillsWorkspaceDirs.set(agentId, normalizedWorkspaceDir);

  const skillsDir = path.join(normalizedWorkspaceDir, "skills");
  if (!fs.existsSync(skillsDir)) {
    return;
  }

  if (!dynamicSkillsRootWatchers.has(agentId)) {
    try {
      const watcher = fs.watch(skillsDir, (_eventType, fileName) => {
        syncDynamicSkillsChildWatchers(agentId, skillsDir, true);
        if (!fileName || String(fileName) === "SKILL.md") {
          recordDynamicSkillDelta(
            agentId,
            "(workspace-root)",
            "updated",
            path.join(skillsDir, "SKILL.md"),
          );
        }
      });

      watcher.on("error", (err) => {
        console.error(`[dingtalk-skills-watch] root watcher error for ${agentId}: ${err}`);
      });

      dynamicSkillsRootWatchers.set(agentId, watcher);
    } catch (err) {
      console.error(`[dingtalk-skills-watch] failed to watch ${skillsDir}: ${err}`);
      return;
    }
  }

  syncDynamicSkillsChildWatchers(agentId, skillsDir, false);
}

export function ensureDynamicAgentRuntimeDirs(dynamicAgentId: string): string {
  const stateDir = resolveStateDir();
  const targetAgentDir = path.join(stateDir, "agents", dynamicAgentId);

  try {
    fs.mkdirSync(path.join(targetAgentDir, "agent"), { recursive: true });
    fs.mkdirSync(path.join(targetAgentDir, "sessions"), { recursive: true });
  } catch (err) {
    console.error(
      `[dingtalk-dynamic-agent] failed to create runtime dirs for ${dynamicAgentId}: ${err}`,
    );
  }

  return targetAgentDir;
}

export function ensureDynamicWorkspaceSeeded(params: {
  dynamicAgentId: string;
  sourceAgentId: string;
  config?: ClawdbotConfig;
}): void {
  const { dynamicAgentId, sourceAgentId, config } = params;

  const stateDir = resolveStateDir();
  const targetWorkspace = resolveDynamicAgentWorkspaceDir(dynamicAgentId);
  const seedMarker = path.join(targetWorkspace, ".seeded");

  ensureDynamicAgentRuntimeDirs(dynamicAgentId);

  if (fs.existsSync(seedMarker)) {
    ensureDynamicSkillsWatcher(dynamicAgentId, targetWorkspace);
    return;
  }

  const candidates: string[] = [];

  if (config) {
    candidates.push(path.resolve(resolveAgentWorkspaceDir(config, sourceAgentId)));
  }

  candidates.push(path.join(stateDir, `workspace-${sourceAgentId}`));
  candidates.push(path.join(stateDir, "workspace"));

  let sourceWorkspace: string | undefined;
  for (const candidate of new Set(candidates.map((item) => path.resolve(item)))) {
    if (fs.existsSync(candidate)) {
      sourceWorkspace = candidate;
      break;
    }
  }

  if (!sourceWorkspace) {
    return;
  }

  try {
    fs.mkdirSync(targetWorkspace, { recursive: true });
  } catch (err) {
    console.error(`[dingtalk-workspace-seed] failed to create target workspace: ${err}`);
    return;
  }

  let seedFailed = false;

  for (const file of DYNAMIC_WORKSPACE_STANDARD_FILES) {
    const src = path.join(sourceWorkspace, file);
    const dest = path.join(targetWorkspace, file);
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dest);
      } catch (err) {
        seedFailed = true;
        console.error(`[dingtalk-workspace-seed] failed to copy ${file}: ${err}`);
      }
    }
  }

  const skillsDir = path.join(sourceWorkspace, "skills");
  if (fs.existsSync(skillsDir)) {
    const targetSkillsDir = path.join(targetWorkspace, "skills");
    try {
      fs.mkdirSync(targetSkillsDir, { recursive: true });
      seedFailed = copyDirRecursive(skillsDir, targetSkillsDir) || seedFailed;
    } catch (err) {
      seedFailed = true;
      console.error(`[dingtalk-workspace-seed] failed to copy skills: ${err}`);
    }
  }

  if (seedFailed) {
    return;
  }

  try {
    fs.writeFileSync(seedMarker, new Date().toISOString());
    ensureDynamicSkillsWatcher(dynamicAgentId, targetWorkspace);
  } catch (err) {
    console.error(`[dingtalk-workspace-seed] failed to write seed marker: ${err}`);
  }
}

function copyDirRecursive(src: string, dest: string): boolean {
  let hadError = false;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        hadError = copyDirRecursive(srcPath, destPath) || hadError;
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (err) {
      hadError = true;
      console.error(`[dingtalk-workspace-seed] failed to copy ${entry.name}: ${err}`);
    }
  }
  return hadError;
}

export function resetEnsuredCache(): void {
  ensuredDynamicAgentIds.clear();

  for (const watcher of dynamicSkillsRootWatchers.values()) {
    watcher.close();
  }
  dynamicSkillsRootWatchers.clear();

  for (const childWatchers of dynamicSkillsChildWatchers.values()) {
    for (const watcher of childWatchers.values()) {
      watcher.close();
    }
  }
  dynamicSkillsChildWatchers.clear();
  dynamicSkillsWorkspaceDirs.clear();
  dynamicSkillsDeltaState.clear();
}

export function resetWorkspaceCache(): void {
  for (const watcher of dynamicSkillsRootWatchers.values()) {
    watcher.close();
  }
  dynamicSkillsRootWatchers.clear();

  for (const childWatchers of dynamicSkillsChildWatchers.values()) {
    for (const watcher of childWatchers.values()) {
      watcher.close();
    }
  }
  dynamicSkillsChildWatchers.clear();
  dynamicSkillsWorkspaceDirs.clear();
  dynamicSkillsDeltaState.clear();
}
