import { describe, expect, test } from "bun:test";

import {
  fromNestedAgentConfig,
  substituteEnvPlaceholders,
  toNestedAgentConfig,
} from "../../../../packages/convex/model/agentConfigCodec";

describe("fromNestedAgentConfig model fields", (): void => {
  test("moves temperature and maxTokens out of provider options", (): void => {
    const patch = fromNestedAgentConfig({
      model: {
        providerOptions: { temperature: 0.2, maxTokens: 500, topK: 4 },
      },
    });

    expect(patch.temperature).toBe(0.2);
    expect(patch.maxTokens).toBe(500);
    expect(patch.providerOptions).toEqual({ topK: 4 });
    expect(patch.extraConfig).toEqual({});
  });

  test("drops provider options that held only the two scalars", (): void => {
    const patch = fromNestedAgentConfig({
      model: { providerOptions: { temperature: 1 } },
    });

    expect(patch.providerOptions).toBeUndefined();
    expect(patch.temperature).toBe(1);
  });

  test("takes an output format into the patch", (): void => {
    const patch = fromNestedAgentConfig({
      model: { output: { type: "text" } },
    });

    expect(patch.outputFormat).toEqual({ type: "text" });
    expect(patch.extraConfig).toEqual({});
  });

  test("a null output clears it without a patch value", (): void => {
    const patch = fromNestedAgentConfig({ model: { output: null } });

    expect(patch.outputFormat).toBeUndefined();
    expect(patch.extraConfig).toEqual({});
  });
});

describe("fromNestedAgentConfig extra config", (): void => {
  test("keeps model leftovers, workspaces and boolean flags", (): void => {
    const patch = fromNestedAgentConfig({
      model: { reasoning: { effort: "low" } },
      workspaces: { main: {} },
      publicAccess: true,
      allowRunOverrides: false,
    });

    expect(patch.extraConfig).toEqual({
      model: { reasoning: { effort: "low" } },
      workspaces: { main: {} },
      publicAccess: true,
      allowRunOverrides: false,
    });
  });
});

describe("toNestedAgentConfig", (): void => {
  test("puts flat scalars back under model, agent and tools", (): void => {
    const nested = toNestedAgentConfig({
      provider: "p",
      modelId: "m",
      temperature: 0.5,
      maxTokens: 90,
      maxTurns: 3,
      systemPrompt: "hi",
      outputFormat: { type: "text" },
      searchToolEnabled: true,
      searchToolConfig: { dynamicThreshold: 0.3 },
    });

    expect(nested).toEqual({
      agent: { maxTurn: 3, system: "hi" },
      model: {
        provider: "p",
        modelId: "m",
        providerOptions: { temperature: 0.5, maxTokens: 90 },
        output: { type: "text" },
      },
      tools: { googleSearch: { enabled: true, dynamicThreshold: 0.3 } },
    });
  });

  test("merges flat provider options into stored ones key by key", (): void => {
    const nested = toNestedAgentConfig({
      providerOptions: { openai: { a: 1 }, plain: 1 },
      extraConfig: {
        model: { providerOptions: { openai: { b: 2 }, plain: 0 } },
      },
    });

    expect(nested.model).toEqual({
      providerOptions: { openai: { b: 2, a: 1 }, plain: 1 },
    });
  });

  test("keeps stored nested objects, pruning the empty ones", (): void => {
    const nested = toNestedAgentConfig({
      extraConfig: { agent: { extra: { inner: {}, kept: 1 } } },
    });

    expect(nested).toEqual({ agent: { extra: { kept: 1 } } });
  });
});

describe("substituteEnvPlaceholders", (): void => {
  test("returns numbers, booleans and null unchanged", (): void => {
    expect(substituteEnvPlaceholders(7, {})).toBe(7);
    expect(substituteEnvPlaceholders(true, {})).toBe(true);
    expect(substituteEnvPlaceholders(null, {})).toBeNull();
  });
});
