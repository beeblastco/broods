// Not a Convex cron: releasing a sandbox calls the in-cluster workdir control plane.

import type { ReservedSandbox } from "../harness/sandbox/types.ts";
import { runtime } from "./convex/runtime.ts";
import { positiveIntegerEnv } from "./env.ts";
import { toErrorMessage } from "./errors.ts";
import { logDebug, logInfo, logWarn } from "./log.ts";
import { releaseExpiredSandboxes } from "./sandbox-cleanup.ts";

const DEFAULT_SWEEP_INTERVAL_SECONDS = 60 * 60;
const FIRST_SWEEP_JITTER_MS = 30_000;
const SWEEP_LEASE_KEY = "sandbox-sweep";
const SWEEP_LEASE_SECONDS = 5 * 60;
const SWEEP_PAGE_SIZE = 100;

interface SandboxReservationSummary extends ReservedSandbox {
  accountId: string;
}

interface OrphanedSandboxPage {
  page: SandboxReservationSummary[];
  cursor: string | null;
  isDone: boolean;
}

let firstSweep: ReturnType<typeof setTimeout> | undefined;
let sweeper: ReturnType<typeof setInterval> | undefined;
let sweeping = false;

export function startSandboxSweeper(): void {
  if (sweeper) return;
  const intervalSeconds = positiveIntegerEnv(
    "SANDBOX_SWEEP_INTERVAL_SECONDS",
    DEFAULT_SWEEP_INTERVAL_SECONDS,
  );
  // Rollouts outpace the interval, so sweep soon after boot; jitter spreads the replicas' leases.
  firstSweep = setTimeout(
    runSweep,
    Math.floor(Math.random() * FIRST_SWEEP_JITTER_MS),
  );
  firstSweep.unref();
  sweeper = setInterval(runSweep, intervalSeconds * 1000);
  sweeper.unref();
}

export function stopSandboxSweeper(): void {
  if (firstSweep) {
    clearTimeout(firstSweep);
    firstSweep = undefined;
  }
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = undefined;
}

export async function sweepExpiredSandboxes(): Promise<number> {
  const [expired, orphaned] = await Promise.all([
    runtime.query("listExpiredSandboxReservations", { limit: SWEEP_PAGE_SIZE }),
    listOrphanedSandboxes(),
  ]);
  const byAccount = new Map<string, SandboxReservationSummary[]>();
  for (const reservation of [...expired, ...orphaned]) {
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
      orphaned: orphaned.length,
      released: released,
    });
  }

  return released;
}

// Pages past empty pages: deferred mirrors keep their age and can fill the oldest page
// forever, hiding every orphan behind them.
async function listOrphanedSandboxes(): Promise<SandboxReservationSummary[]> {
  const orphaned: SandboxReservationSummary[] = [];
  let cursor: string | null = null;
  do {
    const result: OrphanedSandboxPage = await runtime.query(
      "listOrphanedSandboxInstances",
      { cursor: cursor, limit: SWEEP_PAGE_SIZE },
    );
    orphaned.push(...result.page);
    cursor = result.isDone ? null : result.cursor;
  } while (cursor !== null && orphaned.length < SWEEP_PAGE_SIZE);

  return orphaned;
}

async function deferAttempted(
  accountId: string,
  reservations: SandboxReservationSummary[],
): Promise<void> {
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
        error: toErrorMessage(error),
      });
    });
}

function runSweep(): void {
  if (sweeping) return;
  sweeping = true;
  void sweepExpiredSandboxes()
    .catch((error: unknown) => {
      logWarn("Sandbox sweep failed", { error: toErrorMessage(error) });
    })
    .finally(() => {
      sweeping = false;
    });
}

// Every row touched ends released or deferred, so an unclearable row cannot pin the expiry page.
async function sweepAccount(
  accountId: string,
  reservations: SandboxReservationSummary[],
): Promise<number> {
  let leased = false;
  try {
    leased = await runtime.mutate("claimEvent", {
      accountId: accountId,
      key: SWEEP_LEASE_KEY,
      ttlSeconds: SWEEP_LEASE_SECONDS,
    });
  } catch (error) {
    // claimEvent refuses an inactive account: expected, so debug rather than an hourly warning.
    logDebug("Sandbox sweep skipped an inactive account", {
      accountId: accountId,
      error: toErrorMessage(error),
    });
    await deferAttempted(accountId, reservations);

    return 0;
  }
  if (!leased) return 0;

  let pending = reservations;
  try {
    const released = await releaseExpiredSandboxes(accountId, reservations);
    const done = new Set(
      released.map((one) => `${one.provider}:${one.reservationKey}`),
    );
    pending = reservations.filter(
      (one) => !done.has(`${one.provider}:${one.reservationKey}`),
    );
    if (pending.length > 0) {
      logWarn("Sandbox sweep left expired reservations unreleased", {
        accountId: accountId,
        unreleased: pending.map(
          (one) => `${one.provider}:${one.reservationKey}`,
        ),
      });
    }

    return released.length;
  } finally {
    await deferAttempted(accountId, pending);
    await runtime
      .mutate("releaseClaim", { accountId: accountId, key: SWEEP_LEASE_KEY })
      .catch((error: unknown) => {
        logWarn("Sandbox sweep lease release failed", {
          accountId: accountId,
          error: toErrorMessage(error),
        });
      });
  }
}
