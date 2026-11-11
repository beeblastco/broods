import {
  PLATFORM_WORKER_SANDBOX_PROVIDERS,
  SANDBOX_PROVIDERS,
  STATELESS_SANDBOX_PROVIDERS,
} from "@broods/convex/model/sandboxRules";
import { providerExecutor } from "../harness/sandbox/index.ts";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
  getSandboxExternalId,
  getSandboxReleaseTarget,
} from "../harness/sandbox/instance-store.ts";
import { queueMirrorRemove } from "../harness/sandbox/mirror-writes.ts";
import type {
  ReservedSandbox,
  SandboxReleaseTarget,
} from "../harness/sandbox/types.ts";
import { toErrorMessage } from "./errors.ts";
import type {
  SandboxConfig,
  SandboxConfigRecord,
  SandboxProvider,
} from "./domain/sandbox-config.ts";
import { logWarn } from "./log.ts";
import { getStorage } from "./storage.ts";
import { runsOnOwnCredentials } from "./workspaces.ts";

const RELEASABLE_PROVIDERS: readonly SandboxProvider[] =
  SANDBOX_PROVIDERS.filter(
    (provider): boolean => !STATELESS_SANDBOX_PROVIDERS.has(provider),
  );
// Convex's floor, under the sweep interval: the next sweep retries a failed teardown.
const TEARDOWN_RETRY_SECONDS = 60;

interface ReleaseOutcome {
  externalId: string;
  released: boolean;
}

// Takes the row first, a CAS on the listed id and deadline: a run that reconnected since then
// refreshed the deadline and keeps its machine. A failed teardown hands the row back, or else
// leaves the machine to the sweeper.
export async function releaseExpiredSandboxes(
  accountId: string,
  reservations: ReservedSandbox[],
): Promise<ReservedSandbox[]> {
  if (reservations.length === 0) {
    return [];
  }
  const configs = await sandboxConfigs(accountId);

  const released: ReservedSandbox[] = [];
  const removals: Promise<void>[] = [];
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
    const outcome = await releaseOnProvider(
      accountId,
      reservation.provider,
      configs,
      key,
      reservation.externalId,
    );
    if (!outcome?.released) {
      const handedBack = await claimSandboxInstance(
        reservation.provider,
        key,
        reservation.externalId,
        accountId,
        reservation.ttlSeconds,
      ).catch(() => false);
      if (!handedBack) {
        await keepForSweep(
          accountId,
          reservation.provider,
          key,
          reservation.externalId,
        );
      }
      continue;
    }
    released.push(reservation);
    removals.push(queueMirrorRemove(accountId, key, reservation.externalId));
  }
  await Promise.all(removals);

  return released;
}

export async function releaseReservedSandboxes(
  accountId: string,
  namespaces: string[],
): Promise<number> {
  if (namespaces.length === 0) {
    return 0;
  }
  const configs = await sandboxConfigs(accountId);

  let released = 0;
  const removals: Promise<void>[] = [];
  for (const namespace of namespaces) {
    const machines: string[] = [];
    let unreleased = false;
    for (const provider of RELEASABLE_PROVIDERS) {
      const outcome = await releaseOnProvider(
        accountId,
        provider,
        configs,
        namespace,
      );
      // Unknown machine: its reservation stays for the expiry sweep.
      if (outcome === null) {
        unreleased = true;
        continue;
      }
      if (outcome?.released) machines.push(outcome.externalId);
      else if (outcome) unreleased = true;
      // Refused for an account being deleted: its row then still names the machine.
      const dropped = await deleteSandboxInstance(
        provider,
        namespace,
        accountId,
      ).catch(() => false);
      if (dropped && outcome && !outcome.released) {
        await keepForSweep(accountId, provider, namespace, outcome.externalId);
      }
    }
    released += machines.length;
    // The machines it released, so a run that reserved the key since keeps its row and an
    // unreleased machine stays listed for the orphan sweep; with no machine, whatever row is left.
    const fences = machines.length > 0 || unreleased ? machines : [undefined];
    for (const machine of fences) {
      removals.push(queueMirrorRemove(accountId, namespace, machine));
    }
  }
  await Promise.all(removals);

  return released;
}

// Reserves the machine under a key no run uses, so only the sweeper reaches it again.
async function keepForSweep(
  accountId: string,
  provider: SandboxProvider,
  key: string,
  externalId: string,
): Promise<void> {
  try {
    // A hand-back that threw may still have landed, and then a run can reconnect to the machine.
    if ((await getSandboxExternalId(provider, key)) === externalId) return;
    await claimSandboxInstance(
      provider,
      `teardown:${externalId}`,
      externalId,
      accountId,
      TEARDOWN_RETRY_SECONDS,
    );
  } catch (error) {
    logWarn("Unreleased sandbox left without a reservation", {
      provider: provider,
      namespace: key,
      externalId: externalId,
      error: toErrorMessage(error),
    });
  }
}

// Only the owning account's credentials: a release reads 404 as "already gone", so another
// account's would drop a live machine's rows.
function releaseCandidates(
  provider: SandboxProvider,
  records: SandboxConfigRecord[],
  instance: SandboxReleaseTarget["instance"],
): SandboxConfig[] {
  const sameProvider = records.filter(
    (record) => record.config.provider === provider,
  );
  if (instance?.ownCredentials) {
    return sameProvider
      .filter(
        (record) =>
          record.sandboxId === instance.sandboxConfigId &&
          runsOnOwnCredentials(record.config),
      )
      .map((record) => record.config);
  }
  const configs = sameProvider.map((record) => record.config);
  const platform: SandboxConfig = { provider: provider };
  if (instance) {
    return [
      ...configs.filter((config) => !runsOnOwnCredentials(config)),
      platform,
    ];
  }

  return provider === "lambda" ||
    PLATFORM_WORKER_SANDBOX_PROVIDERS.has(provider)
    ? [platform]
    : configs;
}

// Via the reservation's provider, which may differ from every config's now. Undefined when no
// machine was found, null when the lookup failed.
async function releaseOnProvider(
  accountId: string,
  provider: SandboxProvider,
  records: SandboxConfigRecord[],
  namespace: string,
  expectedExternalId?: string,
): Promise<ReleaseOutcome | undefined | null> {
  const target = await getSandboxReleaseTarget(
    accountId,
    provider,
    namespace,
    expectedExternalId,
  ).catch((error: unknown): null => {
    logWarn("Reserved sandbox lookup failed", {
      provider: provider,
      namespace: namespace,
      error: toErrorMessage(error),
    });

    return null;
  });
  if (!target) return null;
  if (!target.externalId) {
    return undefined;
  }
  for (const config of releaseCandidates(provider, records, target.instance)) {
    try {
      const executor = providerExecutor(config);
      if (!executor.release) continue;
      await executor.release({
        namespace: namespace,
        expectedExternalId: target.externalId,
      });

      return { externalId: target.externalId, released: true };
    } catch (error) {
      logWarn("Reserved sandbox release failed", {
        provider: provider,
        namespace: namespace,
        error: toErrorMessage(error),
      });
    }
  }

  return { externalId: target.externalId, released: false };
}

async function sandboxConfigs(
  accountId: string,
): Promise<SandboxConfigRecord[]> {
  return getStorage()
    .sandboxConfigs.list(accountId)
    .catch((error: unknown) => {
      logWarn("Sandbox config list failed", {
        accountId: accountId,
        error: toErrorMessage(error),
      });

      return [];
    });
}
