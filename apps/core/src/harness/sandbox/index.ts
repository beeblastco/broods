/**
 * Sandbox provider registry and executor construction. A provider is one
 * executor file beside this one plus one `registerSandboxProvider` call below;
 * the config plane's `SANDBOX_PROVIDERS` is what names it.
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

type SandboxExecutorFactory = (
  config: SandboxExecutorConfig,
) => SandboxExecutor;

const factories = new Map<SandboxProvider, SandboxExecutorFactory>();

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

/** Names a provider's executor factory; a later call for the same name replaces it. */
export function registerSandboxProvider(
  name: SandboxProvider,
  factory: SandboxExecutorFactory,
): void {
  factories.set(name, factory);
}

function providerExecutor(config: SandboxExecutorConfig): SandboxExecutor {
  // provider is required and always resolved by normalizeSandboxConfig; never
  // silently default here so a misconfigured config fails loudly.
  const factory = factories.get(config.provider);
  if (!factory) {
    throw new Error(`sandbox provider ${config.provider} is not supported`);
  }

  return factory(config);
}

// Built-ins register at module load. The explicit imports above are what pull
// each executor into the compiled binary, like the tool registry in tools/index.ts.
// "lambda" is the AWS Lambda MicroVM backend (the old 4-stage invoke model is gone).
registerSandboxProvider("custom", (config) => new HttpSandboxExecutor(config));
registerSandboxProvider(
  "daytona",
  (config) => new DaytonaSandboxExecutor(config),
);
registerSandboxProvider("e2b", (config) => new E2BSandboxExecutor(config));
registerSandboxProvider(
  "lambda",
  (config) => new MicrovmSandboxExecutor(config),
);
registerSandboxProvider(
  "machine",
  (config) => new MachineSandboxExecutor(config),
);
registerSandboxProvider(
  "sandbox",
  (config) => new WorkdirSandboxExecutor(config),
);
registerSandboxProvider(
  "vercel",
  (config) => new VercelSandboxExecutor(config),
);
