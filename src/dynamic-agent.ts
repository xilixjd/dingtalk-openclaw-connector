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
  skillDescription?: string;
};

type DynamicSkillsDeltaState = {
  changes: Map<string, DynamicSkillDelta>;
};

const dynamicSkillsDeltaState = new Map<string, DynamicSkillsDeltaState>();

type DynamicSkillSnapshot = {
  skillName: string;
  skillDir: string;
  skillFilePath: string;
  signature: string;
};

const dynamicSkillsSnapshotState = new Map<string, Map<string, DynamicSkillSnapshot>>();

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
  skillDescription?: string,
): void {
  const existing = dynamicSkillsDeltaState.get(agentId) ?? {
    changes: new Map<string, DynamicSkillDelta>(),
  };
  existing.changes.set(skillName, {
    skillName,
    changeType,
    skillFilePath,
    ...(skillDescription ? { skillDescription } : {}),
  });
  dynamicSkillsDeltaState.set(agentId, existing);
}

function parseSkillDescriptionLine(line: string): string | undefined {
  const matched = line.match(/^\s*description\s*:\s*(.+?)\s*$/i);
  if (!matched) {
    return undefined;
  }
  const value = matched[1]?.trim();
  if (!value) {
    return undefined;
  }
  return value.replace(/^['"]|['"]$/g, "").trim() || undefined;
}

function readSkillDescription(skillFilePath: string): string | undefined {
  if (!fs.existsSync(skillFilePath)) {
    return undefined;
  }

  let content = "";
  try {
    content = fs.readFileSync(skillFilePath, "utf8");
  } catch {
    return undefined;
  }

  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length === 0) {
    return undefined;
  }

  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === "---" || line.trim() === "...") {
        break;
      }
      const description = parseSkillDescriptionLine(line);
      if (description) {
        return description;
      }
    }
    return undefined;
  }

  for (const line of lines) {
    const description = parseSkillDescriptionLine(line);
    if (description) {
      return description;
    }
  }
  return undefined;
}

function resolveSkillSignature(skillFilePath: string): string | undefined {
  try {
    const stat = fs.statSync(skillFilePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

function collectDynamicSkillsSnapshot(skillsDir: string): Map<string, DynamicSkillSnapshot> {
  const snapshot = new Map<string, DynamicSkillSnapshot>();
  if (!fs.existsSync(skillsDir)) {
    return snapshot;
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return snapshot;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillName = entry.name;
    const skillDir = path.join(skillsDir, skillName);
    const skillFilePath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillFilePath)) {
      continue;
    }

    const signature = resolveSkillSignature(skillFilePath);
    if (!signature) {
      continue;
    }

    snapshot.set(skillName, {
      skillName,
      skillDir,
      skillFilePath,
      signature,
    });
  }

  return snapshot;
}

function diffDynamicSkillsSnapshot(agentId: string, nextSnapshot: Map<string, DynamicSkillSnapshot>): void {
  const prevSnapshot = dynamicSkillsSnapshotState.get(agentId);
  if (!prevSnapshot) {
    // First sync establishes baseline only, avoids startup "all added" noise.
    dynamicSkillsSnapshotState.set(agentId, nextSnapshot);
    return;
  }

  for (const [skillName, prev] of prevSnapshot) {
    const next = nextSnapshot.get(skillName);
    if (!next) {
      recordDynamicSkillDelta(agentId, skillName, "removed", prev.skillFilePath);
      continue;
    }
    if (next.signature !== prev.signature) {
      recordDynamicSkillDelta(agentId, skillName, "updated", next.skillFilePath);
    }
  }

  for (const [skillName, next] of nextSnapshot) {
    if (prevSnapshot.has(skillName)) {
      continue;
    }
    recordDynamicSkillDelta(
      agentId,
      skillName,
      "added",
      next.skillFilePath,
      readSkillDescription(next.skillFilePath),
    );
  }

  dynamicSkillsSnapshotState.set(agentId, nextSnapshot);
}

function syncDynamicSkillsState(agentId: string, workspaceDir: string): void {
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  const existingWorkspaceDir = dynamicSkillsWorkspaceDirs.get(agentId);

  if (existingWorkspaceDir && existingWorkspaceDir !== normalizedWorkspaceDir) {
    dynamicSkillsSnapshotState.delete(agentId);
    dynamicSkillsDeltaState.delete(agentId);
  }

  dynamicSkillsWorkspaceDirs.set(agentId, normalizedWorkspaceDir);
  const skillsDir = path.join(normalizedWorkspaceDir, "skills");
  const nextSnapshot = collectDynamicSkillsSnapshot(skillsDir);
  diffDynamicSkillsSnapshot(agentId, nextSnapshot);
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
    const descriptionSuffix =
      change.changeType === "added" && change.skillDescription
        ? `; description: ${change.skillDescription}`
        : "";
    lines.push(`- ${change.changeType}: ${change.skillName} (${change.skillFilePath})${descriptionSuffix}`);
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
  reconcileDynamicSkillsState(agentId);
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

function reconcileDynamicSkillsState(agentId: string): void {
  const workspaceDir = dynamicSkillsWorkspaceDirs.get(agentId);
  if (!workspaceDir) {
    return;
  }
  syncDynamicSkillsState(agentId, workspaceDir);
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
    syncDynamicSkillsState(dynamicAgentId, targetWorkspace);
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
  } catch (err) {
    console.error(`[dingtalk-workspace-seed] failed to write seed marker: ${err}`);
  }

  syncDynamicSkillsState(dynamicAgentId, targetWorkspace);
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
  ensureDynamicAgentWriteQueue = Promise.resolve();
  dynamicSkillsWorkspaceDirs.clear();
  dynamicSkillsSnapshotState.clear();
  dynamicSkillsDeltaState.clear();
}

export function resetWorkspaceCache(): void {
  dynamicSkillsWorkspaceDirs.clear();
  dynamicSkillsSnapshotState.clear();
  dynamicSkillsDeltaState.clear();
}
