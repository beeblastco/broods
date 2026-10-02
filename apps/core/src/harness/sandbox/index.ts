/**
 * Sandbox provider registry and executor construction. A provider is one
 * executor file beside this one plus one entry in `EXECUTORS` below; the
 * config plane's `SANDBOX_PROVIDERS` is what names it, and the record's key
 * type fails the build when the two drift.
 */

import { DaytonaSandboxExecutor } from "./daytona-executor.ts";
import { E2BSandboxExecutor } from "./e2b-executor.ts";
import { HttpSandboxExecutor } from "./http-executor.ts";
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

// The explicit imports are what pull each executor into the compiled binary,
// like the tool registry in tools/index.ts. "lambda" is the AWS Lambda MicroVM
// backend (the old 4-stage invoke model is gone).
type SandboxExecutorFactory = (
  config: SandboxExecutorConfig,
) => SandboxExecutor;

const EXECUTORS: Record<SandboxProvider, SandboxExecutorFactory> = {
  custom: (config) => new HttpSandboxExecutor(config),
  daytona: (config) => new DaytonaSandboxExecutor(config),
  e2b: (config) => new E2BSandboxExecutor(config),
  lambda: (config) => new MicrovmSandboxExecutor(config),
  machine: (config) => new MachineSandboxExecutor(config),
  sandbox: (config) => new WorkdirSandboxExecutor(config),
  vercel: (config) => new VercelSandboxExecutor(config),
};

/**
 * The executor for a sandbox config. When the config names its account and
 * runs on the platform's credentials (not the account's own), every
 * call that can start or resume compute first checks the account's monthly
 * budget, so a run admitted just before the budget ran out cannot keep
 * launching machines.
 */
export function createSandboxExecutor(
  config: SandboxExecutorConfig,
): SandboxExecutor {
  const executor = providerExecutor(config);
  const accountId = config.controlPlane?.accountId;
  if (!accountId || config.controlPlane?.ownCredentials) return executor;
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
  const prewarm = executor.prewarm?.bind(executor);
  if (prewarm) {
    executor.prewarm = async (request): Promise<void> => {
      await assertSandboxBudget(accountId);

      return prewarm(request);
    };
  }

  return executor;
}

/**
 * The bare executor for a config's provider, with no budget check: what
 * cleanup releases through. A stored config may still name a provider this
 * build does not know, so it fails loudly rather than defaulting.
 */
export function providerExecutor(
  config: SandboxExecutorConfig,
): SandboxExecutor {
  const factory: SandboxExecutorFactory | undefined =
    EXECUTORS[config.provider];
  if (!factory) {
    throw new Error(`sandbox provider ${config.provider} is not supported`);
  }

  return factory(config);
}
