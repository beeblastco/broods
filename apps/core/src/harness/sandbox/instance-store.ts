/** Authoritative Convex mapping from sandbox reservations to provider ids. */

import { runtime } from "../../shared/convex/runtime.ts";
import type { SandboxProvider } from "./types.ts";
export function getSandboxExternalId(
  provider: SandboxProvider,
  reservationKey: string,
): Promise<string | null> {
  return runtime.query("getSandboxReservation", {
    provider: provider,
    reservationKey: reservationKey,
  });
}
// The reserved sandbox and when it was claimed, in one read, for the executors
// that enforce `lifecycle.maxLifetimeSeconds` themselves. Null when unreserved.
export function getSandboxReservationRecord(
  provider: SandboxProvider,
  reservationKey: string,
): Promise<{ externalId: string; claimedAt: number } | null> {
  return runtime.query("getSandboxReservationRecord", {
    provider: provider,
    reservationKey: reservationKey,
  });
}
// The reservation key is a hashed namespace, so the owning account can't be
// derived from it — callers pass accountId from the sandbox control plane. When
// it is absent (synthetic/stateless config) the reservation write is skipped so
// the run degrades to non-persistent instead of failing the tool call.
export function claimSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
  accountId: string | undefined,
): Promise<boolean> {
  if (!accountId) return Promise.resolve(false);

  return runtime.mutate("claimSandboxReservation", {
    provider: provider,
    reservationKey: reservationKey,
    externalId: externalId,
    accountId: accountId,
  });
}
export async function deleteSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  accountId: string | undefined,
  expectedExternalId?: string,
): Promise<void> {
  if (!accountId) return;

  await runtime.mutate("deleteSandboxReservation", {
    provider: provider,
    reservationKey: reservationKey,
    expectedExternalId: expectedExternalId,
    accountId: accountId,
  });
}
// The sweeper's claim on an expired machine, taken before the provider teardown.
// False when a run refreshed or replaced the reservation first.
export function takeExpiredSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  accountId: string,
  expectedExternalId: string,
): Promise<boolean> {
  return runtime.mutate("takeExpiredSandboxReservation", {
    provider: provider,
    reservationKey: reservationKey,
    expectedExternalId: expectedExternalId,
    accountId: accountId,
  });
}
// Refreshes the idle deadline of the reservation that still names `externalId`.
// Never creates or repoints a row: the acquire path owns that through the claim.
export async function saveSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
  accountId: string | undefined,
): Promise<void> {
  if (!accountId) return;

  await runtime.mutate("saveSandboxReservation", {
    provider: provider,
    reservationKey: reservationKey,
    externalId: externalId,
    accountId: accountId,
  });
}
