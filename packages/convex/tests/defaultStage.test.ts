/** The server and the dashboard read stages in different orders; both must pick the same default. */

import { describe, expect, test } from "vitest";
import { defaultStage } from "../model/defaultStage";

describe("defaultStage", () => {
  test("picks the same stage whatever order the stages arrive in", () => {
    // No Development default: the fallbacks are where order used to leak in.
    const stages = [
      { kind: "development" as const, isDefault: false, name: "zeta" },
      { kind: "custom" as const, isDefault: true, name: "main" },
      { kind: "development" as const, isDefault: false, name: "alpha" },
    ];

    expect(defaultStage(stages)?.name).toBe("alpha");
    expect(defaultStage([...stages].reverse())?.name).toBe("alpha");
  });
});
