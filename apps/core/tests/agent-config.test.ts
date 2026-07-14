import { describe, expect, it } from "bun:test";
import {
  normalizeAgentConfig,
  normalizeAgentConfigPatch,
} from "../src/shared/domain/agent-config.ts";

describe("agent config validation", () => {
  it("uses one non-empty string-array policy for config and patches", () => {
    expect(() => normalizeAgentConfig({ skills: { allowed: [""] } }))
      .toThrow("config.skills.allowed must be an array of non-empty strings");
    expect(() => normalizeAgentConfigPatch({ subagent: { allowed: ["  "] } }))
      .toThrow("config.subagent.allowed must be an array of non-empty strings");
    expect(normalizeAgentConfigPatch({ skills: { allowed: ["acct_test/review"] } }))
      .toEqual({ skills: { allowed: ["acct_test/review"] } });
  });
});
