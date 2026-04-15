import path from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDynamicAgentInboundBody,
  ensureDynamicAgentConfigured,
  ensureDynamicAgentRuntimeDirs,
  ensureDynamicAgentListed,
  ensureDynamicWorkspaceSeeded,
  generateAgentId,
  resetEnsuredCache,
  resetWorkspaceCache,
} from "../../src/dynamic-agent.ts";

describe("dynamic-agent", () => {
  const root = path.join("/tmp", `dingtalk-dynamic-agent-${process.pid}`);

  afterEach(async () => {
    resetEnsuredCache();
    resetWorkspaceCache();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("generates stable ids scoped by account and chat type", () => {
    const dmA = generateAgentId("dm", "zhangsan", "acct-a");
    const dmB = generateAgentId("dm", "zhangsan", "acct-b");
    const groupA = generateAgentId("group", "cid-1", "acct-a");

    expect(dmA).toBe("dingtalk-acct-a-dm-zhangsan");
    expect(dmB).toBe("dingtalk-acct-b-dm-zhangsan");
    expect(groupA).toBe("dingtalk-acct-a-group-cid-1");
    expect(dmA).not.toBe(dmB);
  });

  it("creates dynamic agent runtime dirs and seeds workspace from source agent", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);

    const sourceWorkspace = path.join(root, "workspace-main");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "demo-skill");
    await mkdir(sourceSkillDir, { recursive: true });
    await writeFile(path.join(sourceWorkspace, "AGENTS.md"), "source-agents");
    await writeFile(path.join(sourceSkillDir, "SKILL.md"), "demo-skill-v1");

    ensureDynamicAgentRuntimeDirs("dyn-user");
    ensureDynamicWorkspaceSeeded({
      dynamicAgentId: "dyn-user",
      sourceAgentId: "main",
    });

    await expect(
      readFile(path.join(root, "workspace-dyn-user", "AGENTS.md"), "utf8"),
    ).resolves.toBe("source-agents");
    await expect(
      readFile(path.join(root, "workspace-dyn-user", "skills", "demo-skill", "SKILL.md"), "utf8"),
    ).resolves.toBe("demo-skill-v1");

    await expect(stat(path.join(root, "agents", "dyn-user", "agent"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(stat(path.join(root, "agents", "dyn-user", "sessions"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(
      readFile(path.join(root, "workspace-dyn-user", ".seeded"), "utf8"),
    ).resolves.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("does not reseed an already marked workspace", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);

    const sourceWorkspace = path.join(root, "workspace-main");
    await mkdir(sourceWorkspace, { recursive: true });
    await writeFile(path.join(sourceWorkspace, "AGENTS.md"), "source-agents");

    ensureDynamicWorkspaceSeeded({
      dynamicAgentId: "dyn-user",
      sourceAgentId: "main",
    });

    const targetAgentsFile = path.join(root, "workspace-dyn-user", "AGENTS.md");
    await writeFile(targetAgentsFile, "agent-edited");

    ensureDynamicWorkspaceSeeded({
      dynamicAgentId: "dyn-user",
      sourceAgentId: "main",
    });

    await expect(readFile(targetAgentsFile, "utf8")).resolves.toBe("agent-edited");
  });

  it("injects a pending skills runtime note only for next non-command message", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);

    const sourceWorkspace = path.join(root, "workspace-main");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "demo-skill");
    await mkdir(sourceSkillDir, { recursive: true });
    await writeFile(path.join(sourceWorkspace, "AGENTS.md"), "source-agents");
    await writeFile(path.join(sourceSkillDir, "SKILL.md"), "demo-skill-v1");

    ensureDynamicWorkspaceSeeded({
      dynamicAgentId: "dyn-watch-user",
      sourceAgentId: "main",
    });

    const stagingSkillDir = path.join(root, "staging-added-skill");
    await mkdir(stagingSkillDir, { recursive: true });
    await writeFile(
      path.join(stagingSkillDir, "SKILL.md"),
      ["---", "name: added-skill", "description: Added skill description", "---", "", "body"].join("\n"),
    );
    await rename(stagingSkillDir, path.join(root, "workspace-dyn-watch-user", "skills", "added-skill"));

    const commandResult = buildDynamicAgentInboundBody({
      agentId: "dyn-watch-user",
      commandBody: "/new",
      isCommand: true,
    });
    expect(commandResult.modelInputBody).toBe("/new");

    await vi.waitFor(() => {
      const normalResult = buildDynamicAgentInboundBody({
        agentId: "dyn-watch-user",
        commandBody: "hello",
        isCommand: false,
      });
      expect(normalResult.modelInputBody).toContain("[Runtime note: workspace skills changed]");
      expect(normalResult.modelInputBody).toContain("added: added-skill");
      expect(normalResult.modelInputBody).toContain("description: Added skill description");
      expect(normalResult.modelInputBody).toContain("hello");
    });
  });

  it("writes an explicit standalone workspace for dynamic agents", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);

    const latestConfig = {
      defaultAgent: "first",
      agents: {
        defaults: {
          workspace: "~/.openclaw/workspace-first",
        },
        list: [
          {
            id: "first",
            workspace: "~/.openclaw/workspace-first",
          },
        ],
      },
    };

    const writeConfigFile = vi.fn(async () => undefined);

    await ensureDynamicAgentListed("dingtalk-acct-a-dm-zhangsan", {
      config: {
        loadConfig: () => latestConfig,
        writeConfigFile,
      },
    });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    expect(latestConfig.agents.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "dingtalk-acct-a-dm-zhangsan",
          workspace: path.join(root, "workspace-dingtalk-acct-a-dm-zhangsan"),
        }),
      ]),
    );
  });

  it("mutates the active config so the current run sees the standalone workspace", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);

    const cfg = {
      defaultAgent: "first",
      agents: {
        defaults: {
          workspace: "~/.openclaw/workspace-first",
        },
        list: [
          {
            id: "first",
            workspace: "~/.openclaw/workspace-first",
          },
        ],
      },
    } as any;

    const changed = ensureDynamicAgentConfigured("dingtalk-main-dm-015300235036375480620", cfg);

    expect(changed).toBe(true);
    expect(cfg.agents.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "dingtalk-main-dm-015300235036375480620",
          workspace: path.join(root, "workspace-dingtalk-main-dm-015300235036375480620"),
        }),
      ]),
    );
  });
});
