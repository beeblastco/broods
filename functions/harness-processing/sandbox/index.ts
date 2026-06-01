/**
 * Sandbox provider selection.
 * Keep executor construction here; provider implementations live beside it.
 */

import { LambdaSandboxExecutor } from "./lambda-executor.ts";
import { E2BSandboxExecutor } from "./e2b-executor.ts";
import { DaytonaSandboxExecutor } from "./daytona-executor.ts";
import { KubernetesSandboxExecutor } from "./kubernetes-executor.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxProvider,
} from "./types.ts";

export const SANDBOX_PROVIDERS = ["lambda", "e2b", "daytona", "kubernetes"] as const satisfies readonly SandboxProvider[];

export function createSandboxExecutor(config: SandboxExecutorConfig): SandboxExecutor {
  const provider = config.provider ?? "lambda";
  if (provider === "lambda") {
    return new LambdaSandboxExecutor(config);
  }
  if (provider === "e2b") {
    return new E2BSandboxExecutor(config);
  }
  if (provider === "daytona") {
    return new DaytonaSandboxExecutor(config);
  }
  if (provider === "kubernetes") {
    return new KubernetesSandboxExecutor(config);
  }

  throw new Error(`sandbox provider ${provider} is not supported`);
}
