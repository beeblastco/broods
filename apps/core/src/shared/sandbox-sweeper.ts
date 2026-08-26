/**
 * Periodic release of reserved sandboxes whose conversation never came back.
 * `lifecycle.maxLifetimeSeconds` only ever runs on acquire, so it bounds the sandboxes
 * that return and nothing else. Lives here, not in a Convex cron, because deleting a
 * sandbox means calling the in-cluster workdir control plane.
 */

import { runtime } from "./convex/runtime.ts";
import type { SandboxProvider } from "./domain/sandbox-config.ts";
import { positiveIntegerEnv } from "./env.ts";
import { logInfo, logWarn } from "./log.ts";
import { releaseExpiredSandboxes } from "./sandbox-cleanup.ts";

const DEFAULT_SWEEP_INTERVAL_SECONDS = 60 * 60;
const SWEEP_LEASE_KEY = "sandbox-sweep";
const SWEEP_LEASE_SECONDS = 5 * 60;
const SWEEP_PAGE_SIZE = 100;

interface SandboxReservationSummary {
  accountId: string;
  provider: SandboxProvider;
  reservationKey: string;
  externalId: string;
}

let sweeper: ReturnType<typeof setInterval> | undefined;

/** Starts the periodic sweep. No-op when it is already running. */
export function startSandboxSweeper(): void {
  if (sweeper) return;
  const intervalSeconds = positiveIntegerEnv(
    "SANDBOX_SWEEP_INTERVAL_SECONDS",
    DEFAULT_SWEEP_INTERVAL_SECONDS,
  );
  sweeper = setInterval(() => {
    void sweepExpiredSandboxes().catch((error: unknown) => {
      logWarn("Sandbox sweep failed", { error: errorMessage(error) });
    });
  }, intervalSeconds * 1000);
  // A pending sweep must not hold the process open past SIGTERM.
  sweeper.unref();
}

/** Stops the periodic sweep. The timer outlives requests, so shutdown clears it. */
export function stopSandboxSweeper(): void {
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
    logWarn("Sandbox sweep lease failed", {
      accountId: accountId,
      error: errorMessage(error),
    });
    await deferAttempted(accountId, reservations);

    return 0;
  }
  // Another replica owns this account's sweep; it defers whatever it misses.
  if (!leased) return 0;

  try {
    return await releaseExpiredSandboxes(accountId, reservations);
  } finally {
    await deferAttempted(accountId, reservations);
  }
}
