/**
 * Workspace sandbox executor tests.
 * Cover provider selection without invoking real third-party services.
 */

import { describe, expect, it } from "bun:test";
import { createWorkspaceSandboxExecutor } from "../functions/harness-processing/sandbox/index.ts";

describe("createWorkspaceSandboxExecutor", () => {
  it("creates the built-in Lambda executor by default", () => {
    const executor = createWorkspaceSandboxExecutor({});
    expect(executor.constructor.name).toBe("LambdaWorkspaceSandboxExecutor");
  });

  it("creates E2B and Daytona executor adapters", () => {
    expect(createWorkspaceSandboxExecutor({ provider: "e2b" }).constructor.name)
      .toBe("E2BWorkspaceSandboxExecutor");
    expect(createWorkspaceSandboxExecutor({ provider: "daytona" }).constructor.name)
      .toBe("DaytonaWorkspaceSandboxExecutor");
  });
});
