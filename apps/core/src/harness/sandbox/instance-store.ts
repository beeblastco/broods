import { runtime } from "../../shared/convex/runtime.ts";
import type { SandboxProvider, SandboxReleaseTarget } from "./types.ts";
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
// True when the caller now owns the machine's teardown, false when a run refreshed it first.
export async function deleteSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  accountId: string | undefined,
  expectedExternalId?: string,
  onlyExpired?: boolean,
): Promise<boolean> {
  if (!accountId) return false;

  return runtime.mutate("deleteSandboxReservation", {
    provider: provider,
    reservationKey: reservationKey,
    expectedExternalId: expectedExternalId,
    onlyExpired: onlyExpired,
    accountId: accountId,
  });
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
