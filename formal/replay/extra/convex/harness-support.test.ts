import { describe, expect, test } from "bun:test";

import { assertAgentHarnessSupport } from "../../../../packages/convex/model/agentRules";

describe("assertAgentHarnessSupport", (): void => {
  test("accepts configs with no harness, whatever else they hold", (): void => {
    expect((): void => assertAgentHarnessSupport({})).not.toThrow();
    expect((): void =>
      assertAgentHarnessSupport({
        policies: ["pol_1"],
        model: { output: { type: "object" }, providerOptions: { a: 1 } },
      }),
    ).not.toThrow();
    expect((): void =>
      assertAgentHarnessSupport({ harness: null }),
    ).not.toThrow();
  });

  test("accepts a harness with plain text output", (): void => {
    expect((): void =>
      assertAgentHarnessSupport({
        harness: { type: "claude-code" },
        policies: [],
        model: { output: { type: "text" } },
      }),
    ).not.toThrow();
  });

  test("refuses policies, structured output and providerOptions beside a harness", (): void => {
    expect((): void =>
      assertAgentHarnessSupport({
        harness: { type: "codex" },
        policies: ["p"],
      }),
    ).toThrow("config.policies is not supported with config.harness");
    expect((): void =>
      assertAgentHarnessSupport({
        harness: { type: "codex" },
        model: { output: { type: "object" } },
      }),
    ).toThrow(
      "config.model.output structured output is not supported with config.harness",
    );
    expect((): void =>
      assertAgentHarnessSupport({
        harness: { type: "codex" },
        subagent: { model: { providerOptions: {} } },
      }),
    ).toThrow(
      "config.subagent.model.providerOptions is not supported with config.harness; set config.subagent.model.reasoning",
    );
  });

  test("refuses a config of the wrong shape", (): void => {
    expect((): void =>
      assertAgentHarnessSupport({ harness: {}, policies: "all" }),
    ).toThrow();
  });
});
