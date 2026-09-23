/**
 * Sandbox provider selection.
 * Keep executor construction here; provider implementations live beside it.
 */

import { DaytonaSandboxExecutor } from "./daytona-executor.ts";
import { E2BSandboxExecutor } from "./e2b-executor.ts";
import { MachineSandboxExecutor } from "./machine-executor.ts";
import { assertSandboxBudget } from "../plan-limits.ts";
import { MicrovmSandboxExecutor } from "./microvm-executor.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobHandle,
  SandboxProvider,
  SandboxRunResult,
} from "./types.ts";
import { VercelSandboxExecutor } from "./vercel-executor.ts";
import { WorkdirSandboxExecutor } from "./workdir-executor.ts";

export const SANDBOX_PROVIDERS = [
  "sandbox",
  "lambda",
  "e2b",
  "daytona",
  "vercel",
  "machine",
] as const satisfies readonly SandboxProvider[];

/**
 * The executor for a sandbox config. When the config names its account, every
 * call that can start or resume compute first checks the account's monthly
 * budget, so a run admitted just before the budget ran out cannot keep
 * launching machines.
 */
export function createSandboxExecutor(
  config: SandboxExecutorConfig,
): SandboxExecutor {
  const executor = providerExecutor(config);
  const accountId = config.controlPlane?.accountId;
  if (!accountId || config.provider === "machine") return executor;
  const run = executor.run.bind(executor);
  executor.run = async (request): Promise<SandboxRunResult> => {
    await assertSandboxBudget(accountId);

    return run(request);
  };
  const runBackground = executor.runBackground?.bind(executor);
  if (runBackground) {
    executor.runBackground = async (request): Promise<SandboxJobHandle> => {
      await assertSandboxBudget(accountId);

      return runBackground(request);
    };
  }
  const resume = executor.resume?.bind(executor);
  if (resume) {
    executor.resume = async (request): Promise<void> => {
      await assertSandboxBudget(accountId);

      return resume(request);
    };
  }

  return executor;
}

function providerExecutor(config: SandboxExecutorConfig): SandboxExecutor {
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
  if (provider === "machine") {
    return new MachineSandboxExecutor(config);
  }

  throw new Error(`sandbox provider ${provider} is not supported`);
}
