/**
 * Shared cleanup helpers for persistent sandbox reservations. Account deletion,
 * workspace deletion, channel-scoped cleanup, and the sandbox sweeper all need the
 * same provider release path: the provider that reserved the machine, which may
 * no longer be what any config says.
 */

import { DaytonaSandboxExecutor } from "../harness/sandbox/daytona-executor.ts";
import { E2BSandboxExecutor } from "../harness/sandbox/e2b-executor.ts";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxExternalId,
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
import { logWarn } from "./log.ts";
import { getStorage } from "./storage.ts";

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
 * since the listing refreshed the deadline, and tearing the machine down under that
 * run would lose its sandbox. Only once the row is taken is the machine torn down,
 * by the id the sweeper holds. A failed teardown hands the row back, so the
 * sweeper's deferral spaces the retry out instead of the orphan listing offering
 * the same machine every pass.
 */
export async function releaseExpiredSandboxes(
  accountId: string,
  reservations: ReservedSandbox[],
): Promise<ReservedSandbox[]> {
  if (reservations.length === 0) {
    return [];
  }
  const configs = await sandboxConfigs(accountId);

  const released: ReservedSandbox[] = [];
  for (const reservation of reservations) {
    const key = reservation.reservationKey;
    const taken = await deleteSandboxInstance(
      reservation.provider,
      key,
      accountId,
      reservation.externalId,
      true,
    ).catch((error: unknown) => {
      logWarn("Expired sandbox reservation take failed", {
        provider: reservation.provider,
        namespace: key,
        error: toErrorMessage(error),
      });

      return false;
    });
    if (!taken) continue;
    const done = await releaseOnProvider(
      reservation.provider,
      configs,
      key,
      reservation.externalId,
      reservation.ownCredentials === true,
    );
    if (!done) {
      // The claim refuses if a run mapped the key meanwhile, which is right:
      // that run's machine is not ours to defer.
      await claimSandboxInstance(
        reservation.provider,
        key,
        reservation.externalId,
        accountId,
        reservation.ttlSeconds,
      ).catch(() => false);
      continue;
    }
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
  const configs = await sandboxConfigs(accountId);

  let released = 0;
  for (const namespace of namespaces) {
    for (const provider of RELEASABLE_PROVIDERS) {
      // No instance row to say whose credentials it ran on, but the row goes
      // either way, so the platform's are worth the try.
      if (await releaseOnProvider(provider, configs, namespace)) released++;
      await deleteSandboxInstance(provider, namespace, accountId).catch(
        () => {},
      );
    }
    await removeSandboxInstance(accountId, namespace);
  }

  return released;
}

async function sandboxConfigs(accountId: string): Promise<SandboxConfig[]> {
  const configs = await getStorage()
    .sandboxConfigs.list(accountId)
    .catch((error: unknown) => {
      logWarn("Sandbox config list failed, only platform credentials remain", {
        accountId: accountId,
        error: toErrorMessage(error),
      });

      return [];
    });

  return configs.map((record) => record.config);
}

/**
 * Tears down the machine `provider` reserved under `namespace`. Every config of
 * that provider is tried, persistent or not: turning `persistent` off or
 * switching provider leaves the machine where it was. Then the platform's own
 * credentials, unless the machine runs on the tenant's, where a 404 from the
 * wrong account would read as "already gone".
 * @returns whether the machine is gone; false when nothing was reserved
 */
async function releaseOnProvider(
  provider: SandboxProvider,
  configs: SandboxConfig[],
  namespace: string,
  expectedExternalId?: string,
  ownCredentials = false,
): Promise<boolean> {
  const externalId =
    expectedExternalId ?? (await getSandboxExternalId(provider, namespace));
  if (!externalId) {
    return false;
  }
  const candidates = configs.filter((config) => config.provider === provider);
  if (!ownCredentials) candidates.push({ provider: provider });
  for (const config of candidates) {
    try {
      await executorFor(config).release({
        namespace: namespace,
        expectedExternalId: externalId,
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

function executorFor(
  config: SandboxConfig,
):
  | DaytonaSandboxExecutor
  | E2BSandboxExecutor
  | MicrovmSandboxExecutor
  | VercelSandboxExecutor
  | WorkdirSandboxExecutor {
  switch (config.provider) {
    case "daytona":
      return new DaytonaSandboxExecutor(config);
    case "e2b":
      return new E2BSandboxExecutor(config);
    case "lambda":
      return new MicrovmSandboxExecutor(config);
    case "sandbox":
      return new WorkdirSandboxExecutor(config);
    default:
      return new VercelSandboxExecutor(config);
  }
}
