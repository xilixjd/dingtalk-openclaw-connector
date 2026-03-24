import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAxiosPost = vi.hoisted(() => vi.fn());
const mockAxiosGet = vi.hoisted(() => vi.fn());

vi.mock("axios", () => ({
  default: {
    post: mockAxiosPost,
    get: mockAxiosGet,
  },
}));

describe("utils-legacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAxiosPost.mockResolvedValue({
      data: { accessToken: "tk", expireIn: 7200 },
    });
    mockAxiosGet.mockResolvedValue({
      data: { errcode: 0, access_token: "oapi_tk", expires_in: 7200 },
    });
  });

  it("getAccessToken caches token", async () => {
    const { getAccessToken } = await import("../../src/utils/utils-legacy");
    const cfg = { clientId: "ut-id", clientSecret: "ut-secret" } as any;
    const t1 = await getAccessToken(cfg);
    const t2 = await getAccessToken(cfg);
    expect(t1).toBe("tk");
    expect(t2).toBe("tk");
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });

  it("getOapiAccessToken caches and returns null on failure", async () => {
    const { getOapiAccessToken } = await import("../../src/utils/utils-legacy");
    const cfg = { clientId: "ut-oapi", clientSecret: "sec" } as any;
    const t = await getOapiAccessToken(cfg);
    expect(t).toBe("oapi_tk");

    mockAxiosGet.mockRejectedValueOnce(new Error("network"));
    const cfg2 = { clientId: "ut-fail", clientSecret: "sec" } as any;
    const t2 = await getOapiAccessToken(cfg2);
    expect(t2).toBeNull();
  });

  it("getUnionId caches result and handles failure", async () => {
    mockAxiosGet
      .mockResolvedValueOnce({ data: { errcode: 0, access_token: "oapi", expires_in: 7200 } })
      .mockResolvedValueOnce({ data: { unionid: "union-1" } });

    const { getUnionId } = await import("../../src/utils/utils-legacy");
    const cfg = { clientId: "uid-id", clientSecret: "sec" } as any;
    const uid = await getUnionId("staff1", cfg);
    expect(uid).toBe("union-1");

    const uid2 = await getUnionId("staff1", cfg);
    expect(uid2).toBe("union-1");
  });

  it("message dedup helpers work", async () => {
    const {
      isMessageProcessed,
      markMessageProcessed,
      cleanupProcessedMessages,
    } = await import("../../src/utils/utils-legacy");
    expect(isMessageProcessed("")).toBe(false);
    expect(isMessageProcessed("m1")).toBe(false);
    markMessageProcessed("m1");
    expect(isMessageProcessed("m1")).toBe(true);
    cleanupProcessedMessages();
    expect(isMessageProcessed("m1")).toBe(true);
  });

  it("getDingtalkConfig and isDingtalkConfigured", async () => {
    const { getDingtalkConfig, isDingtalkConfigured } = await import("../../src/utils/utils-legacy");
    expect(getDingtalkConfig({})).toEqual({});
    expect(isDingtalkConfigured({})).toBe(false);
    expect(
      isDingtalkConfigured({
        channels: { "dingtalk-connector": { clientId: "a", clientSecret: "b" } },
      }),
    ).toBe(true);
  });

  it("buildMediaSystemPrompt returns markdown", async () => {
    const { buildMediaSystemPrompt } = await import("../../src/utils/utils-legacy");
    const prompt = buildMediaSystemPrompt();
    expect(prompt).toContain("DINGTALK_VIDEO");
    expect(prompt).toContain("DINGTALK_AUDIO");
    expect(prompt).toContain("DINGTALK_FILE");
  });

  it("addEmotionReply and recallEmotionReply skip without ids", async () => {
    const { addEmotionReply, recallEmotionReply } = await import("../../src/utils/utils-legacy");
    const cfg = { clientId: "c", clientSecret: "s" } as any;
    await addEmotionReply(cfg, {});
    await recallEmotionReply(cfg, {});
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it("addEmotionReply posts and handles error", async () => {
    const { addEmotionReply } = await import("../../src/utils/utils-legacy");
    mockAxiosPost
      .mockResolvedValueOnce({ data: { accessToken: "tk", expireIn: 7200 } })
      .mockResolvedValueOnce({ data: {} });
    const cfg = { clientId: "em-id", clientSecret: "sec" } as any;
    await addEmotionReply(cfg, { msgId: "m1", conversationId: "c1" });
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);

    mockAxiosPost.mockRejectedValueOnce(new Error("fail"));
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    await addEmotionReply(cfg, { msgId: "m2", conversationId: "c2" }, log);
    expect(log.warn).toHaveBeenCalled();
  });

  it("buildSessionContext handles all branches", async () => {
    const { buildSessionContext } = await import("../../src/utils/utils-legacy");

    const direct = buildSessionContext({
      accountId: "a",
      senderId: "u1",
      conversationType: "1",
    });
    expect(direct.chatType).toBe("direct");

    const grouped = buildSessionContext({
      accountId: "a",
      senderId: "u1",
      conversationType: "2",
      conversationId: "c1",
      groupSessionScope: "group_sender",
    });
    expect(grouped.peerId).toBe("c1");
    expect(grouped.sessionPeerId).toBe("c1:u1");

    const shared = buildSessionContext({
      accountId: "a",
      senderId: "u1",
      conversationType: "2",
      conversationId: "c1",
      separateSessionByConversation: false,
    });
    expect(shared.peerId).toBe("c1");
    expect(shared.sessionPeerId).toBe("u1");
  });
});
