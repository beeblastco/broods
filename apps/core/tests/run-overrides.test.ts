/**
 * Per-run override parsing/folding: the whitelist on top-level `model`, system
 * message validation, and applyRunOverrides folding overrides into a config copy.
 */

import { describe, expect, it } from "bun:test";
import { parseRunOverrides } from "../functions/harness-processing/integrations.ts";
import { applyRunOverrides, type AgentConfig } from "../functions/_shared/storage/index.ts";

describe("parseRunOverrides", () => {
  it("returns undefined when overrides are absent", () => {
    expect(parseRunOverrides({})).toBeUndefined();
  });

  it("accepts system messages and whitelisted model overrides", () => {
    const overrides = parseRunOverrides({
      system: { role: "system", content: "one-turn instructions" },
      model: {
        providerOptions: { openai: { reasoningEffort: "high" } },
        temperature: 0.3,
        maxOutputTokens: 4096,
      },
    });
    expect(overrides).toEqual({
      system: [{ role: "system", content: "one-turn instructions" }],
      model: {
        providerOptions: { openai: { reasoningEffort: "high" } },
        temperature: 0.3,
        maxOutputTokens: 4096,
      },
    });
  });

  it("rejects reserved identity/credential keys (provider/modelId/output/apiKey)", () => {
    for (const key of ["provider", "modelId", "output", "apiKey"]) {
      expect(() => parseRunOverrides({ model: { [key]: "x" } })).toThrow(/cannot be overridden per run/);
    }
  });

  it("forwards AI SDK call settings and providerOptions", () => {
    const overrides = parseRunOverrides({
      model: {
        temperature: 0.2,
        topP: 0.9,
        stopSequences: ["END"],
        providerOptions: { anthropic: { thinking: { type: "enabled" } } },
      },
    });
    expect(overrides?.model).toEqual({
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ["END"],
      providerOptions: { anthropic: { thinking: { type: "enabled" } } },
    });
  });

  it("rejects unsupported model override keys", () => {
    for (const key of ["options", "thinking", "thinkingConfig", "unknownSetting"]) {
      expect(() => parseRunOverrides({ model: { [key]: "x" } })).toThrow(
        `model.${key} is not supported; use model.providerOptions for provider-specific settings`,
      );
    }
  });

  it("rejects non-message system overrides", () => {
    expect(() => parseRunOverrides({ system: "one-turn instructions" })).toThrow(/SystemModelMessage/);
    expect(() => parseRunOverrides({ system: 42 })).toThrow(/SystemModelMessage/);
  });

  it("rejects the params wrapper", () => {
    expect(() => parseRunOverrides({ params: { model: { temperature: 0 } } })).toThrow("Request body params is not supported");
  });
});

describe("applyRunOverrides", () => {
  const base: AgentConfig = {
    agent: { system: "base" },
    model: { provider: "minimax", modelId: "MiniMax-M3", temperature: 1 },
  };

  it("returns the original config untouched when there are no overrides", () => {
    expect(applyRunOverrides(base, undefined)).toBe(base);
    expect(applyRunOverrides(base, { system: [{ role: "system", content: "only-system" }] })).toBe(base);
  });

  it("folds model overrides without mutating the original", () => {
    const next = applyRunOverrides(base, { model: { temperature: 0.2, maxOutputTokens: 512 } });
    expect(next).not.toBe(base);
    expect(next.model).toMatchObject({ provider: "minimax", modelId: "MiniMax-M3", temperature: 0.2, maxOutputTokens: 512 });
    expect(base.model?.temperature).toBe(1);
  });
});
