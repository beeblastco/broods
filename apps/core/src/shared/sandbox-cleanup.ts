import {
  PLATFORM_WORKER_SANDBOX_PROVIDERS,
  SANDBOX_PROVIDERS,
  STATELESS_SANDBOX_PROVIDERS,
} from "@broods/convex/model/sandboxRules";
import { providerExecutor } from "../harness/sandbox/index.ts";
import {
  claimSandboxInstance,
  deleteSandboxInstance,
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

// Takes the row first, a CAS on the listed id and deadline: a run that reconnected since then
// refreshed the deadline and keeps its machine. A failed teardown hands the row back.
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
    const done = !!(await releaseOnProvider(
      accountId,
      reservation.provider,
      configs,
      key,
      reservation.externalId,
    ));
    if (!done) {
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
    let machine: string | undefined;
    for (const provider of RELEASABLE_PROVIDERS) {
      const releasedId = await releaseOnProvider(
        accountId,
        provider,
        configs,
        namespace,
      );
      if (releasedId) {
        released++;
        machine = releasedId;
      }
      await deleteSandboxInstance(provider, namespace, accountId).catch(
        () => {},
      );
    }
    // Only the machine it released: a run that reserved the key since keeps its row.
    removals.push(queueMirrorRemove(accountId, namespace, machine));
  }
  await Promise.all(removals);

  return released;
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

// Via the reservation's provider, which may differ from every config's now. Answers the id of
// the machine it released.
async function releaseOnProvider(
  accountId: string,
  provider: SandboxProvider,
  records: SandboxConfigRecord[],
  namespace: string,
  expectedExternalId?: string,
): Promise<string | undefined> {
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
  if (!target?.externalId) {
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

      return target.externalId;
    } catch (error) {
      logWarn("Reserved sandbox release failed", {
        provider: provider,
        namespace: namespace,
        error: toErrorMessage(error),
      });
    }
  }

  return undefined;
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
