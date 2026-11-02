import { CloudflareSandboxExecutor } from "./cloudflare-executor.ts";
import { DaytonaSandboxExecutor } from "./daytona-executor.ts";
import { E2BSandboxExecutor } from "./e2b-executor.ts";
import { HttpSandboxExecutor } from "./http-executor.ts";
import { WorkerSandboxExecutor } from "./worker-executor.ts";
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

const EXECUTORS: Record<SandboxProvider, SandboxExecutorFactory> = {
  cloudflare: (config): SandboxExecutor =>
    new CloudflareSandboxExecutor(config),
  custom: (config): SandboxExecutor => new HttpSandboxExecutor(config),
  daytona: (config): SandboxExecutor => new DaytonaSandboxExecutor(config),
  e2b: (config): SandboxExecutor => new E2BSandboxExecutor(config),
  lambda: (config): SandboxExecutor => new MicrovmSandboxExecutor(config),
  machine: (config): SandboxExecutor => new MachineSandboxExecutor(config),
  sandbox: (config): SandboxExecutor => new WorkdirSandboxExecutor(config),
  vercel: (config): SandboxExecutor => new VercelSandboxExecutor(config),
  worker: (config): SandboxExecutor => new WorkerSandboxExecutor(config),
};

// Budget checked per call: a run admitted just before it ran out cannot keep launching machines.
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
  const postReserved = executor.postReserved?.bind(executor);
  if (postReserved) {
    executor.postReserved = async (request): Promise<unknown> => {
      await assertSandboxBudget(accountId);

      return postReserved(request);
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

// No budget check: cleanup must still release once the budget is spent.
export function providerExecutor(
  config: SandboxExecutorConfig,
): SandboxExecutor {
  if (!Object.hasOwn(EXECUTORS, config.provider)) {
    throw new Error(`sandbox provider ${config.provider} is not supported`);
  }

  return EXECUTORS[config.provider](config);
}
