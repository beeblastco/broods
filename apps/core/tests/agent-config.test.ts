import { describe, expect, it } from "bun:test";
import {
  normalizeAgentConfig,
  normalizeAgentConfigPatch,
} from "../src/shared/domain/agent-config.ts";

describe("agent config validation", () => {
  it("uses one non-empty string-array policy for config and patches", () => {
    expect(() => normalizeAgentConfig({ skills: { allowed: [""] } })).toThrow(
      "config.skills.allowed must be an array of non-empty strings",
    );
    expect(() =>
      normalizeAgentConfigPatch({ subagent: { allowed: ["  "] } }),
    ).toThrow("config.subagent.allowed must be an array of non-empty strings");
    expect(
      normalizeAgentConfigPatch({ skills: { allowed: ["acct_test/review"] } }),
    ).toEqual({ skills: { allowed: ["acct_test/review"] } });
  });

  it("accepts native Convex resource ids and rejects deprecated public ids", () => {
    const toolId = "qs78zwc4z4q5ysxm74fgrhd13s88xxt";
    const hookId = "k17zwc4z4q5ysxm74fgrhd13s88xxtv";

    expect(
      normalizeAgentConfig({
        tools: { [toolId]: { enabled: true } },
        hooks: { code: [{ hookId }] },
      }),
    ).toMatchObject({
      tools: { [toolId]: { enabled: true } },
      hooks: { code: [{ hookId }] },
    });
    expect(() =>
      normalizeAgentConfig({ tools: { tool_legacy: { enabled: true } } }),
    ).toThrow("config.tools.tool_legacy is not a supported tool");
    expect(() =>
      normalizeAgentConfig({ hooks: { code: [{ hookId: "hook_legacy" }] } }),
    ).toThrow(
      "config.hooks.code[0].hookId must be a native Convex document id",
    );
  });
});
