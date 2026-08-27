/**
 * Workspace harness feature toggle tests. Config validation moved to the
 * config plane and is covered by packages/convex/tests/workspaceRules.test.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  workspaceGuidanceEnabled,
  workspaceMemoryHarnessEnabled,
} from "../src/shared/domain/workspace-config.ts";

describe("workspace harness toggles", () => {
  it("defaults both harness features on and toggles them independently", () => {
    expect(workspaceMemoryHarnessEnabled({ storage: { provider: "s3" } })).toBe(
      true,
    );
    expect(workspaceMemoryHarnessEnabled(undefined)).toBe(true);
    expect(workspaceGuidanceEnabled({ storage: { provider: "s3" } })).toBe(
      true,
    );
    expect(workspaceGuidanceEnabled(undefined)).toBe(true);
    // The toggles are orthogonal: turning one feature off leaves the other on.
    const workspacePromptOff = {
      storage: { provider: "s3" as const },
      harness: { workspace: { enabled: false } },
    };
    expect(workspaceGuidanceEnabled(workspacePromptOff)).toBe(false);
    expect(workspaceMemoryHarnessEnabled(workspacePromptOff)).toBe(true);
    const memoryOff = {
      storage: { provider: "s3" as const },
      harness: { memory: { enabled: false } },
    };
    expect(workspaceGuidanceEnabled(memoryOff)).toBe(true);
    expect(workspaceMemoryHarnessEnabled(memoryOff)).toBe(false);
  });
});
