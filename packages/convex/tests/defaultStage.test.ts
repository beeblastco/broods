import { describe, expect, test } from "vitest";
import { defaultStage } from "../model/defaultStage";

describe("defaultStage", () => {
  test("picks the same stage whatever order the stages arrive in", () => {
    // No Development default, so the order-sensitive fallbacks pick the stage.
    const stages = [
      { kind: "development" as const, isDefault: false, name: "zeta" },
      { kind: "custom" as const, isDefault: true, name: "main" },
      { kind: "development" as const, isDefault: false, name: "alpha" },
    ];

    expect(defaultStage(stages)?.name).toBe("alpha");
    expect(defaultStage([...stages].reverse())?.name).toBe("alpha");
  });
});
