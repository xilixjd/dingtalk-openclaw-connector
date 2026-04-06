import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAgentWorkspaceDir } from "../../src/utils/agent.ts";

describe("agent workspace resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps dynamic agents out of agents.defaults.workspace", () => {
    vi.stubEnv("HOME", "/fake-home");
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/openclaw-state");

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

    expect(resolveAgentWorkspaceDir(cfg, "second")).toBe(
      path.join("/fake-home", ".openclaw", "workspace-first", "second"),
    );
    expect(resolveAgentWorkspaceDir(cfg, "dingtalk-acct-a-dm-zhangsan")).toBe(
      "/tmp/openclaw-state/workspace-dingtalk-acct-a-dm-zhangsan",
    );
  });
});
