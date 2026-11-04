import { runtime } from "../../shared/convex/runtime.ts";
import type { SandboxProvider, SandboxReleaseTarget } from "./types.ts";

// A booking is trusted this long; the next one checks the account and pushes the deadline out,
// far inside the 7-day TTL.
const REVALIDATE_MS = 60_000;
const MAX_HELD = 10_000;
// Bookings by provider and key. A reservation delete here lets its key go, and a booking that
// was in flight across any delete is not held.
const held = new Map<
  string,
  { accountId: string; id: string; checkedAt: number }
>();
let deletes = 0;

export function resetHeldReservationsForTests(): void {
  held.clear();
}

export function getSandboxExternalId(
  provider: SandboxProvider,
  reservationKey: string,
): Promise<string | null> {
  return runtime.query("getSandboxReservation", {
    provider: provider,
    reservationKey: reservationKey,
  });
}
// `expiresAt` is unix seconds, the sweeper's clock.
export function getSandboxReservationRecord(
  provider: SandboxProvider,
  reservationKey: string,
): Promise<{
  externalId: string;
  claimedAt: number;
  expiresAt: number;
} | null> {
  return runtime.query("getSandboxReservationRecord", {
    provider: provider,
    reservationKey: reservationKey,
  });
}
export function getSandboxReleaseTarget(
  accountId: string,
  provider: SandboxProvider,
  reservationKey: string,
  externalId?: string,
): Promise<SandboxReleaseTarget> {
  return runtime.query("getSandboxReleaseTarget", {
    accountId: accountId,
    provider: provider,
    reservationKey: reservationKey,
    externalId: externalId,
  });
}
// No accountId (a synthetic config): skip the write, the run degrades to non-persistent.
export function claimSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
  accountId: string | undefined,
  ttlSeconds?: number,
): Promise<boolean> {
  if (!accountId) return Promise.resolve(false);

  return runtime.mutate("claimSandboxReservation", {
    provider: provider,
    reservationKey: reservationKey,
    externalId: externalId,
    accountId: accountId,
    ttlSeconds: ttlSeconds,
  });
}
// Claim-or-reuse in one trip: the id already under the key, else `externalId` as a new claim.
// A booking this account made in the last `REVALIDATE_MS` answers without Convex.
export async function reserveSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
  accountId: string,
): Promise<string> {
  const entry = `${provider}:${reservationKey}`;
  const hit = held.get(entry);
  if (
    hit?.accountId === accountId &&
    Date.now() - hit.checkedAt < REVALIDATE_MS
  )
    return hit.id;
  const epoch = deletes;
  const id = await runtime.mutate("reserveSandboxReservation", {
    provider: provider,
    reservationKey: reservationKey,
    externalId: externalId,
    accountId: accountId,
  });
  if (epoch === deletes) {
    // Re-holding moves the key to the end, so the cap drops the longest unused.
    held.delete(entry);
    if (held.size >= MAX_HELD) {
      const oldest = held.keys().next().value;
      if (oldest !== undefined) held.delete(oldest);
    }
    held.set(entry, { accountId: accountId, id: id, checkedAt: Date.now() });
  }

  return id;
}
// Drops the reservation row while it still names `expectedExternalId`; with
// `onlyExpired`, only once its deadline lapsed. True when the caller now owns the
// teardown of that machine, false when a run refreshed or replaced it first.
export async function deleteSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  accountId: string | undefined,
  expectedExternalId?: string,
  onlyExpired?: boolean,
): Promise<boolean> {
  const entry = `${provider}:${reservationKey}`;
  held.delete(entry);
  if (!accountId) return false;
  try {
    return await runtime.mutate("deleteSandboxReservation", {
      provider: provider,
      reservationKey: reservationKey,
      expectedExternalId: expectedExternalId,
      onlyExpired: onlyExpired,
      accountId: accountId,
    });
  } finally {
    // A booking made while the row went may hold it.
    held.delete(entry);
    deletes += 1;
  }
}
// Only refreshes a row still naming `externalId`; the claim alone creates or repoints rows.
export async function saveSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
  accountId: string | undefined,
  ttlSeconds?: number,
): Promise<void> {
  if (!accountId) return;

  await runtime.mutate("saveSandboxReservation", {
    provider: provider,
    reservationKey: reservationKey,
    externalId: externalId,
    accountId: accountId,
    ttlSeconds: ttlSeconds,
  });
}
