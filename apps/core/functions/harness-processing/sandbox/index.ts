/**
 * Sandbox provider selection.
 * Keep executor construction here; provider implementations live beside it.
 */

import { WorkdirSandboxExecutor } from "./workdir-executor.ts";
import { MicrovmSandboxExecutor } from "./microvm-executor.ts";
import { E2BSandboxExecutor } from "./e2b-executor.ts";
import { DaytonaSandboxExecutor } from "./daytona-executor.ts";
import { VercelSandboxExecutor } from "./vercel-executor.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxProvider,
} from "./types.ts";

export const SANDBOX_PROVIDERS = ["sandbox", "lambda", "e2b", "daytona", "vercel"] as const satisfies readonly SandboxProvider[];

export function createSandboxExecutor(config: SandboxExecutorConfig): SandboxExecutor {
  // provider is required and always resolved by normalizeSandboxConfig; never
  // silently default here so a misconfigured config fails loudly.
  const { provider } = config;
  if (provider === "sandbox") {
    return new WorkdirSandboxExecutor(config);
  }
  if (provider === "lambda") {
    // "lambda" is the AWS Lambda MicroVM backend (the old 4-stage invoke model is gone).
    return new MicrovmSandboxExecutor(config);
  }
  if (provider === "e2b") {
    return new E2BSandboxExecutor(config);
  }
  if (provider === "daytona") {
    return new DaytonaSandboxExecutor(config);
  }
  if (provider === "vercel") {
    return new VercelSandboxExecutor(config);
  }

  throw new Error(`sandbox provider ${provider} is not supported`);
}
