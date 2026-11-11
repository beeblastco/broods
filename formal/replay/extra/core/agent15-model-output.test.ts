import { describe, expect, test } from "bun:test";

import { modelOutputFromModelConfig } from "../../../../apps/core/src/harness/provider.ts";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";

type ModelOutput = NonNullable<NonNullable<AgentConfig["model"]>["output"]>;

function specFor(output: ModelOutput): { name: string } | undefined {
  return modelOutputFromModelConfig({
    model: { provider: "openai", modelId: "gpt-test", output: output },
  }) as { name: string } | undefined;
}

describe("modelOutputFromModelConfig", (): void => {
  test.each<[string, ModelOutput]>([
    [
      "object",
      {
        type: "object",
        schema: { type: "object", properties: { a: { type: "string" } } },
        name: "answer",
        description: "the answer",
      },
    ],
    [
      "array",
      {
        type: "array",
        element: { type: "string" },
        name: "items",
        description: "the items",
      },
    ],
    [
      "choice",
      {
        type: "choice",
        options: ["yes", "no"],
        name: "verdict",
        description: "the verdict",
      },
    ],
    ["json", { type: "json", name: "blob", description: "any json" }],
  ])(
    "builds a %s spec carrying its name and description",
    (type: string, output: ModelOutput): void => {
      expect(specFor(output)?.name).toBe(type);
    },
  );

  test.each<[string, ModelOutput]>([
    ["object", { type: "object", schema: { type: "object" } }],
    ["array", { type: "array", element: { type: "string" } }],
    ["choice", { type: "choice", options: ["a"] }],
    ["json", { type: "json" }],
  ])("builds a bare %s spec", (type: string, output: ModelOutput): void => {
    expect(specFor(output)?.name).toBe(type);
  });

  test("needs no spec for text or no output", (): void => {
    expect(specFor({ type: "text" })).toBeUndefined();
    expect(modelOutputFromModelConfig({})).toBeUndefined();
  });
});
