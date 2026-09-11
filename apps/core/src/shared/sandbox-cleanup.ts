/**
 * Shared cleanup helpers for persistent sandbox reservations. Account deletion,
 * workspace deletion, channel-scoped cleanup, and the sandbox sweeper all need the
 * same provider release path.
 */

import { DaytonaSandboxExecutor } from "../harness/sandbox/daytona-executor.ts";
import { E2BSandboxExecutor } from "../harness/sandbox/e2b-executor.ts";
import {
  deleteSandboxInstance,
  takeExpiredSandboxInstance,
} from "../harness/sandbox/instance-store.ts";
import { MicrovmSandboxExecutor } from "../harness/sandbox/microvm-executor.ts";
import type { ReservedSandbox } from "../harness/sandbox/types.ts";
import { VercelSandboxExecutor } from "../harness/sandbox/vercel-executor.ts";
import { WorkdirSandboxExecutor } from "../harness/sandbox/workdir-executor.ts";
import { removeSandboxInstance } from "./convex/sandbox-instances.ts";
import { toErrorMessage } from "./errors.ts";
import type {
  SandboxConfig,
  SandboxProvider,
} from "./domain/sandbox-config.ts";
import { toErrorMessage } from "./errors.ts";
import { logWarn } from "./log.ts";
import { getStorage } from "./storage.ts";
import { workspaceNamespace } from "./workspaces.ts";

const RELEASABLE_PROVIDERS: readonly SandboxProvider[] = [
  "daytona",
  "e2b",
  "lambda",
  "sandbox",
  "vercel",
];

/**
 * Release the reservations the sweeper found expired. The row goes first, as a
 * compare-and-swap on the id and deadline the sweeper read: a run that reconnected
 * to the machine since the listing refreshed the deadline, and tearing it down
 * under that run would lose its sandbox. Only once the row is taken is the machine
 * torn down, by the id the sweeper holds. A teardown that then fails is not
 * re-inserted: the mirror row still names the machine, and the next sweep picks
 * up a mirror row without a reservation.
 */
export async function releaseExpiredSandboxes(
  accountId: string,
  reservations: ReservedSandbox[],
): Promise<ReservedSandbox[]> {
  if (reservations.length === 0) {
    return [];
  }
  const configs = await persistentSandboxConfigs(accountId);

  const released: ReservedSandbox[] = [];
  for (const reservation of reservations) {
    const key = reservation.reservationKey;
    const taken = await takeExpiredSandboxInstance(
      reservation.provider,
      key,
      accountId,
      reservation.externalId,
    ).catch((error: unknown) => {
      logWarn("Expired sandbox reservation take failed", {
        provider: reservation.provider,
        namespace: key,
        error: toErrorMessage(error),
      });

      return false;
    });
    if (!taken) continue;
    const done = await releaseFromConfigs(
      reservation.provider,
      configs,
      key,
      reservation.externalId,
    );
    if (!done) continue;
    released.push(reservation);
    await removeSandboxInstance(accountId, key, reservation.externalId);
  }

  return released;
}

/**
 * Clean delete of reserved sandboxes for the given workspace namespaces. The caller is
 * discarding the namespace, so a row no config could release is dropped with it.
 * Idempotent: a namespace with no reserved sandbox is a cheap no-op.
 */
export async function releaseReservedSandboxes(
  accountId: string,
  namespaces: string[],
): Promise<number> {
  if (namespaces.length === 0) {
    return 0;
  }
  const configs = await persistentSandboxConfigs(accountId);

  let released = 0;
  for (const namespace of namespaces) {
    for (const provider of RELEASABLE_PROVIDERS) {
      if (await releaseFromConfigs(provider, configs, namespace)) released++;
      await deleteSandboxInstance(provider, namespace, accountId).catch(
        () => {},
      );
    }
    await removeSandboxInstance(accountId, namespace);
  }

  return released;
}

/**
 * Release reserved sandbox/lambda/daytona/e2b/vercel sandboxes created from a
 * single config, across all of the account's workspace namespaces.
 */
export async function releaseSandboxConfigInstances(
  accountId: string,
  config: SandboxConfig,
): Promise<number> {
  if (config.persistent !== true) {
    return 0;
  }
  const workspaceConfigs = await getStorage()
    .workspaceConfigs.list(accountId)
    .catch(() => []);
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

async function persistentSandboxConfigs(
  accountId: string,
): Promise<SandboxConfig[]> {
  const configs = await getStorage()
    .sandboxConfigs.list(accountId)
    .catch((error: unknown) => {
      logWarn("Sandbox config list failed, nothing can be released", {
        accountId: accountId,
        error: toErrorMessage(error),
      });

      return [];
    });

  return configs
    .map((record) => record.config)
    .filter((config) => config.persistent === true);
}

async function releaseFromConfigs(
  provider: SandboxProvider,
  configs: SandboxConfig[],
  namespace: string,
  expectedExternalId?: string,
): Promise<boolean> {
  for (const config of configs) {
    if (config.provider !== provider) continue;
    try {
      const executor =
        provider === "sandbox"
          ? new WorkdirSandboxExecutor(config)
          : provider === "lambda"
            ? new MicrovmSandboxExecutor(config)
            : provider === "daytona"
              ? new DaytonaSandboxExecutor(config)
              : provider === "e2b"
                ? new E2BSandboxExecutor(config)
                : new VercelSandboxExecutor(config);
      await executor.release({
        namespace: namespace,
        expectedExternalId: expectedExternalId,
      });

      return true;
    } catch (error) {
      logWarn("Reserved sandbox release failed", {
        provider: provider,
        namespace: namespace,
        error: toErrorMessage(error),
      });
    }
  }

  return false;
}
