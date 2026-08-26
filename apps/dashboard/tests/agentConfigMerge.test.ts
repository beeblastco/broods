import { describe, expect, test } from "bun:test";
import { mergeNestedAgentConfig } from "../app/lib/agentConfigMerge";
import {
  fromNestedAgentConfig,
  toNestedAgentConfig,
  type FlatAgentConfig,
} from "../app/lib/agentConfigCodec";

describe("Advanced editor save path (mergeNestedAgentConfig)", () => {
  test("an edit while a scheduler branch exists preserves the branch", () => {
    // The known defect (00 §2a): the old Config save rewrote extraConfig with
    // only agent/model/provider and silently dropped scheduler/workspaces/...
    const existing: FlatAgentConfig = {
      name: "vertex-key-test",
      provider: "vertex",
      modelId: "gemini-3.7-flash",
      extraConfig: {
        provider: { vertex: { apiKey: "${VERTEX_API_KEY}" } },
        scheduler: { enabled: true },
        workspaces: [{ name: "desk", workspaceId: "q57abc" }],
        publicAccess: false,
      },
    };

    const base = toNestedAgentConfig(existing) as Record<string, unknown>;
    // The user edits only the model branch in the editor.
    const edited = {
      ...base,
      model: { provider: "vertex", modelId: "gemini-3.8-pro" },
    };

    const merged = mergeNestedAgentConfig(base, edited);
    const patch = fromNestedAgentConfig(merged) as {
      modelId?: string;
      extraConfig?: Record<string, unknown>;
    };

    expect(patch.modelId).toBe("gemini-3.8-pro");
    expect(patch.extraConfig?.scheduler).toEqual({ enabled: true });
    expect(patch.extraConfig?.workspaces).toEqual([
      { name: "desk", workspaceId: "q57abc" },
    ]);
    expect(patch.extraConfig?.publicAccess).toBe(false);
  });

  test("a branch missing from the edit survives; an edited branch replaces wholesale", () => {
    const base = {
      model: { provider: "vertex", modelId: "a" },
      scheduler: { enabled: true },
      skills: { allowed: ["acct/skill-a"] },
    };
    const merged = mergeNestedAgentConfig(base, {
      skills: { allowed: [] },
    });

    expect(merged.scheduler).toEqual({ enabled: true });
    expect(merged.model).toEqual({ provider: "vertex", modelId: "a" });
    expect(merged.skills).toEqual({ allowed: [] });
  });
});
