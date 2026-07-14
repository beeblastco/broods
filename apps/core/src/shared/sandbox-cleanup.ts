/**
 * Shared cleanup helpers for persistent sandbox reservations. Account deletion,
 * workspace deletion, and channel-scoped cleanup all need the same provider
 * release path.
 */

import { getStorage } from "./storage.ts";
import type { SandboxConfig } from "./domain/sandbox-config.ts";
import { workspaceNamespace } from "./workspaces.ts";
import { logWarn } from "./log.ts";
import { deleteSandboxInstance } from "../harness/sandbox/instance-store.ts";
import { WorkdirSandboxExecutor } from "../harness/sandbox/workdir-executor.ts";
import { MicrovmSandboxExecutor } from "../harness/sandbox/microvm-executor.ts";
import { DaytonaSandboxExecutor } from "../harness/sandbox/daytona-executor.ts";
import { E2BSandboxExecutor } from "../harness/sandbox/e2b-executor.ts";
import { VercelSandboxExecutor } from "../harness/sandbox/vercel-executor.ts";
import { removeSandboxInstance } from "./convex/sandbox-instances.ts";

type ReleasableSandboxProvider = "sandbox" | "lambda" | "daytona" | "e2b" | "vercel";

/**
 * Clean delete of reserved sandboxes for the given workspace namespaces.
 * Idempotent: a namespace with no reserved sandbox is a cheap no-op.
 */
export async function releaseReservedSandboxes(accountId: string, namespaces: string[]): Promise<number> {
  if (namespaces.length === 0) {
    return 0;
  }
  const configs = await getStorage().sandboxConfigs.list(accountId).catch(() => []);
  const persistent = configs.map((record) => record.config).filter((config) => config.persistent === true);
  const sandbox = persistent.filter((config) => config.provider === "sandbox");
  const lambda = persistent.filter((config) => config.provider === "lambda");
  const daytona = persistent.filter((config) => config.provider === "daytona");
  const e2b = persistent.filter((config) => config.provider === "e2b");
  const vercel = persistent.filter((config) => config.provider === "vercel");

  let released = 0;
  for (const namespace of namespaces) {
    if (await releaseFromConfigs("sandbox", sandbox, namespace)) released++;
    if (await releaseFromConfigs("lambda", lambda, namespace)) released++;
    if (await releaseFromConfigs("daytona", daytona, namespace)) released++;
    if (await releaseFromConfigs("e2b", e2b, namespace)) released++;
    if (await releaseFromConfigs("vercel", vercel, namespace)) released++;
    // Drop any orphaned instance rows (e.g. all configs deleted, or none owned it).
    await deleteSandboxInstance("sandbox", namespace).catch(() => {});
    await deleteSandboxInstance("lambda", namespace).catch(() => {});
    await deleteSandboxInstance("daytona", namespace).catch(() => {});
    await deleteSandboxInstance("e2b", namespace).catch(() => {});
    await deleteSandboxInstance("vercel", namespace).catch(() => {});
    await removeSandboxInstance(accountId, namespace);
  }
  return released;
}

/**
 * Release reserved sandbox/lambda/daytona/e2b/vercel sandboxes created from a
 * single config, across all of the account's workspace namespaces.
 */
export async function releaseSandboxConfigInstances(accountId: string, config: SandboxConfig): Promise<number> {
  if (config.persistent !== true || !isReleasableProvider(config.provider)) {
    return 0;
  }
  const workspaceConfigs = await getStorage().workspaceConfigs.list(accountId).catch(() => []);
  let released = 0;
  for (const workspace of workspaceConfigs) {
    const namespace = workspaceNamespace(accountId, workspace.workspaceId);
    if (await releaseFromConfigs(config.provider, [config], namespace)) {
      released++;
      await removeSandboxInstance(accountId, namespace);
    }
  }
  return released;
}

function isReleasableProvider(provider: SandboxConfig["provider"]): provider is ReleasableSandboxProvider {
  return provider === "sandbox" || provider === "lambda" || provider === "daytona" || provider === "e2b" || provider === "vercel";
}

async function releaseFromConfigs(
  provider: ReleasableSandboxProvider,
  configs: SandboxConfig[],
  namespace: string,
): Promise<boolean> {
  for (const config of configs) {
    try {
      const executor = provider === "sandbox"
        ? new WorkdirSandboxExecutor(config)
        : provider === "lambda"
        ? new MicrovmSandboxExecutor(config)
        : provider === "daytona"
        ? new DaytonaSandboxExecutor(config)
        : provider === "e2b"
        ? new E2BSandboxExecutor(config)
        : new VercelSandboxExecutor(config);
      await executor.release({ namespace });
      return true;
    } catch (error) {
      logWarn("Reserved sandbox release failed", {
        provider,
        namespace,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return false;
}
