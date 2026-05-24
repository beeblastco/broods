/**
 * Workspace sandbox provider selection.
 * Keep executor construction here; provider implementations live beside it.
 */

import { LambdaWorkspaceSandboxExecutor } from "./lambda-executor.ts";
import { E2BWorkspaceSandboxExecutor } from "./e2b-executor.ts";
import { DaytonaWorkspaceSandboxExecutor } from "./daytona-executor.ts";
import type {
  WorkspaceSandboxConfig,
  WorkspaceSandboxExecutor,
  WorkspaceSandboxProvider,
} from "./types.ts";

export const WORKSPACE_SANDBOX_PROVIDERS = ["lambda", "e2b", "daytona"] as const satisfies readonly WorkspaceSandboxProvider[];

export function createWorkspaceSandboxExecutor(config: WorkspaceSandboxConfig): WorkspaceSandboxExecutor {
  const provider = config.provider ?? "lambda";
  if (provider === "lambda") {
    return new LambdaWorkspaceSandboxExecutor(config);
  }
  if (provider === "e2b") {
    return new E2BWorkspaceSandboxExecutor(config);
  }
  if (provider === "daytona") {
    return new DaytonaWorkspaceSandboxExecutor(config);
  }

  throw new Error(`config.workspace.sandbox.provider ${provider} is not supported`);
}
