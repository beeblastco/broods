/**
 * Periodic release of reserved sandboxes whose conversation never came back.
 * `lifecycle.maxLifetimeSeconds` only ever runs on acquire, so it bounds the sandboxes
 * that return and nothing else. Lives here, not in a Convex cron, because deleting a
 * sandbox means calling the in-cluster workdir control plane.
 */

import { runtime } from "./convex/runtime.ts";
import { positiveIntegerEnv } from "./env.ts";
import { logDebug, logInfo, logWarn } from "./log.ts";
import {
  releaseExpiredSandboxes,
  type SandboxReservationRef,
} from "./sandbox-cleanup.ts";

const DEFAULT_SWEEP_INTERVAL_SECONDS = 60 * 60;
const FIRST_SWEEP_JITTER_MS = 30_000;
const SWEEP_LEASE_KEY = "sandbox-sweep";
const SWEEP_LEASE_SECONDS = 5 * 60;
const SWEEP_PAGE_SIZE = 100;

interface SandboxReservationSummary extends SandboxReservationRef {
  accountId: string;
  externalId: string;
}

let firstSweep: ReturnType<typeof setTimeout> | undefined;
let sweeper: ReturnType<typeof setInterval> | undefined;
let sweeping = false;

/** Starts the periodic sweep. No-op when it is already running. */
export function startSandboxSweeper(): void {
  if (sweeper) return;
  const intervalSeconds = positiveIntegerEnv(
    "SANDBOX_SWEEP_INTERVAL_SECONDS",
    DEFAULT_SWEEP_INTERVAL_SECONDS,
  );
  // A pod that restarts more often than the interval would otherwise never sweep
  // once, and rollouts are more frequent than an hour. Jittered so replicas coming
  // up together do not all reach for the same account lease.
  firstSweep = setTimeout(
    runSweep,
    Math.floor(Math.random() * FIRST_SWEEP_JITTER_MS),
  );
  firstSweep.unref();
  sweeper = setInterval(runSweep, intervalSeconds * 1000);
  // A pending sweep must not hold the process open past SIGTERM.
  sweeper.unref();
}

/** Stops the periodic sweep. The timers outlive requests, so shutdown clears them. */
export function stopSandboxSweeper(): void {
  if (firstSweep) {
    clearTimeout(firstSweep);
    firstSweep = undefined;
  }
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = undefined;
}

/**
 * One sweep pass, bounded to a page so a backlog drains over several runs.
 * @returns the number of sandboxes released at their provider
 */
export async function sweepExpiredSandboxes(): Promise<number> {
  const expired = await runtime.query<SandboxReservationSummary[]>(
    "listExpiredSandboxReservations",
    { limit: SWEEP_PAGE_SIZE },
  );
  const adopted = await adoptOrphanedInstances();
  const byAccount = new Map<string, SandboxReservationSummary[]>();
  for (const reservation of [...expired, ...adopted]) {
    const pending = byAccount.get(reservation.accountId) ?? [];
    pending.push(reservation);
    byAccount.set(reservation.accountId, pending);
  }

  let released = 0;
  for (const [accountId, reservations] of byAccount) {
    released += await sweepAccount(accountId, reservations);
  }
  if (byAccount.size > 0) {
    logInfo("Sandbox sweep completed", {
      accounts: byAccount.size,
      expired: expired.length,
      adopted: adopted.length,
      released: released,
    });
  }

  return released;
}

/**
 * Mirror rows whose reservation the old prune deleted without telling the provider.
 * Re-claiming the reservation from the id the mirror still holds is what makes the
 * normal teardown reachable again; a refused claim means the sandbox is in use.
 */
async function adoptOrphanedInstances(): Promise<SandboxReservationSummary[]> {
  const orphans = await runtime.query<SandboxReservationSummary[]>(
    "listOrphanedSandboxInstances",
    { limit: SWEEP_PAGE_SIZE },
  );
  const adopted: SandboxReservationSummary[] = [];
  for (const orphan of orphans) {
    const claimed = await runtime
      .mutate<boolean>("claimSandboxReservation", {
        provider: orphan.provider,
        reservationKey: orphan.reservationKey,
        externalId: orphan.externalId,
        accountId: orphan.accountId,
      })
      .catch((error: unknown) => {
        logWarn("Orphaned sandbox adoption failed", {
          accountId: orphan.accountId,
          provider: orphan.provider,
          error: errorMessage(error),
        });

        return false;
      });
    if (claimed) adopted.push(orphan);
  }

  return adopted;
}

async function deferAttempted(
  accountId: string,
  reservations: SandboxReservationSummary[],
): Promise<void> {
  // A pass that released everything has nothing left to hold off, and the mutation
  // would be one round-trip per account per hour saying so.
  if (reservations.length === 0) {
    return;
  }
  await runtime
    .mutate("deferSandboxReservations", {
      accountId: accountId,
      reservations: reservations.map((reservation) => ({
        provider: reservation.provider,
        reservationKey: reservation.reservationKey,
      })),
    })
    .catch((error: unknown) => {
      logWarn("Sandbox sweep deferral failed", {
        accountId: accountId,
        error: errorMessage(error),
      });
    });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One pass, guarded so a slow one cannot stack. The lease already stops two
 * replicas duplicating an account; this stops one replica racing itself when a
 * pass outlives the interval.
 */
function runSweep(): void {
  if (sweeping) return;
  sweeping = true;
  void sweepExpiredSandboxes()
    .catch((error: unknown) => {
      logWarn("Sandbox sweep failed", { error: errorMessage(error) });
    })
    .finally(() => {
      sweeping = false;
    });
}

/**
 * Sweeps one account under a lease. Whatever this touches ends the pass released or
 * deferred, so a row that can never be cleared cannot hold the head of the expiry page.
 */
async function sweepAccount(
  accountId: string,
  reservations: SandboxReservationSummary[],
): Promise<number> {
  let leased = false;
  try {
    leased = await runtime.mutate<boolean>("claimEvent", {
      accountId: accountId,
      key: SWEEP_LEASE_KEY,
      ttlSeconds: SWEEP_LEASE_SECONDS,
    });
  } catch (error) {
    // The lease requires an active account, so this one is suspended or deleted.
    // Expected, and it would otherwise warn once an hour forever.
    logDebug("Sandbox sweep skipped an inactive account", {
      accountId: accountId,
      error: errorMessage(error),
    });
    await deferAttempted(accountId, reservations);

    return 0;
  }
  // Another replica owns this account's sweep; it defers whatever it misses.
  if (!leased) return 0;

  // Deferring what was just released would push its expiry forward and hide it
  // from the next pass, so only what survived the pass is deferred.
  let pending = reservations;
  try {
    const released = await releaseExpiredSandboxes(accountId, reservations);
    const done = new Set(
      released.map((one): string => `${one.provider}:${one.reservationKey}`),
    );
    pending = reservations.filter(
      (one): boolean => !done.has(`${one.provider}:${one.reservationKey}`),
    );

    return released.length;
  } finally {
    await deferAttempted(accountId, pending);
  }
}
