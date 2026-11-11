import { describe, expect, test } from "bun:test";

import { fromNestedAgentConfig } from "../../../../packages/convex/model/agentConfigCodec";

type Nested = Parameters<typeof fromNestedAgentConfig>[0];

function patchOf(nested: Nested): ReturnType<typeof fromNestedAgentConfig> {
  return fromNestedAgentConfig(nested);
}

describe("fromNestedAgentConfig agent fields", (): void => {
  test("moves maxTurn and system into the flat patch and out of extraConfig", (): void => {
    const patch = patchOf({
      agent: { maxTurn: 7, system: "be brief", tone: "dry" },
    });

    expect(patch.maxTurns).toBe(7);
    expect(patch.systemPrompt).toBe("be brief");
    expect(JSON.stringify(patch.extraConfig)).toContain("dry");
    expect(JSON.stringify(patch.extraConfig)).not.toContain("be brief");
  });

  test("leaves a value of the wrong type where it is", (): void => {
    const patch = patchOf({ agent: { maxTurn: "7", system: 3 } });

    expect(patch.maxTurns).toBeUndefined();
    expect(patch.systemPrompt).toBeUndefined();
    expect(patch.extraConfig).toBeDefined();
    expect(JSON.stringify(patch.extraConfig)).toContain('"maxTurn":"7"');
  });

  test("takes one of the two when only one is given", (): void => {
    expect(patchOf({ agent: { maxTurn: 2 } }).systemPrompt).toBeUndefined();
    expect(patchOf({ agent: { system: "only" } }).maxTurns).toBeUndefined();
  });
});

describe("fromNestedAgentConfig search tool fields", (): void => {
  test("splits the enabled flag from the rest of the search config", (): void => {
    const patch = patchOf({
      tools: { googleSearch: { enabled: true, dynamicThreshold: 0.4 } },
    });

    expect(patch.searchToolEnabled).toBe(true);
    expect(patch.searchToolConfig).toEqual({ dynamicThreshold: 0.4 });
  });

  test("keeps no config when the flag is all there is", (): void => {
    const patch = patchOf({ tools: { googleSearch: { enabled: false } } });

    expect(patch.searchToolEnabled).toBe(false);
    expect(patch.searchToolConfig).toBeUndefined();
  });

  test("keeps a non-boolean flag inside the config", (): void => {
    const patch = patchOf({ tools: { googleSearch: { enabled: "yes" } } });

    expect(patch.searchToolEnabled).toBeUndefined();
    expect(patch.searchToolConfig).toEqual({ enabled: "yes" });
  });

  test("an empty search config sets nothing", (): void => {
    const patch = patchOf({ tools: { googleSearch: {} } });

    expect(patch.searchToolEnabled).toBeUndefined();
    expect(patch.searchToolConfig).toBeUndefined();
  });
});
