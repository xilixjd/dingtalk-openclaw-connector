import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAgentWorkspaceDir } from "../../src/utils/agent.ts";

describe("agent workspace resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers explicit dynamic-agent workspace overrides and keeps core fallback for others", () => {
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
          {
            id: "dingtalk-acct-a-dm-zhangsan",
            workspace: "/tmp/openclaw-state/workspace-dingtalk-acct-a-dm-zhangsan",
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
