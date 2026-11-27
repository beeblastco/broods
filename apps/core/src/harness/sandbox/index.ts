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
  SandboxProvider,
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
  executor.run = budgeted(accountId, executor.run.bind(executor));
  if (executor.runBackground) {
    executor.runBackground = budgeted(
      accountId,
      executor.runBackground.bind(executor),
    );
  }
  if (executor.resume) {
    executor.resume = budgeted(accountId, executor.resume.bind(executor));
  }
  if (executor.postReserved) {
    executor.postReserved = budgeted(
      accountId,
      executor.postReserved.bind(executor),
    );
  }
  if (executor instanceof MicrovmSandboxExecutor) {
    executor.acquireHarnessReservation = budgeted(
      accountId,
      executor.acquireHarnessReservation.bind(executor),
    );
    executor.resumeHarnessReservation = budgeted(
      accountId,
      executor.resumeHarnessReservation.bind(executor),
    );
    executor.runHarnessCommand = budgeted(
      accountId,
      executor.runHarnessCommand.bind(executor),
    );
  }
  if (executor instanceof WorkdirSandboxExecutor) {
    executor.acquireHarnessReservation = budgeted(
      accountId,
      executor.acquireHarnessReservation.bind(executor),
    );
    executor.resumeHarnessReservation = budgeted(
      accountId,
      executor.resumeHarnessReservation.bind(executor),
    );
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

function budgeted<Request, Result>(
  accountId: string,
  call: (request: Request) => Promise<Result>,
): (request: Request) => Promise<Result> {
  return async (request: Request): Promise<Result> => {
    await assertSandboxBudget(accountId);

    return call(request);
  };
}
