import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";

describe("openclaw.plugin.json channel schema", () => {
  it("accepts dynamicAgents config in channels.dingtalk-connector", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      channelConfigs?: Record<string, { schema?: object }>;
    };

    const dingtalkSchema = manifest.channelConfigs?.["dingtalk-connector"]?.schema;
    expect(dingtalkSchema).toBeDefined();

    const validate = new Ajv({ allErrors: true, strict: false }).compile({
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            "dingtalk-connector": dingtalkSchema,
          },
          additionalProperties: true,
        },
      },
      additionalProperties: true,
    });

    const ok = validate({
      channels: {
        "dingtalk-connector": {
          enabled: true,
          dynamicAgents: {
            enabled: true,
            dmCreateAgent: true,
            groupEnabled: true,
            adminUsers: ["admin-1"],
            workspaceSeed: true,
          },
        },
      },
    });

    expect(validate.errors).toBeNull();
    expect(ok).toBe(true);
  });
});
