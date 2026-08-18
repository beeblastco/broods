/** Authoritative Convex mapping from sandbox reservations to provider ids. */

import { runtime } from "../../shared/convex/runtime.ts";
import type { SandboxProvider } from "./types.ts";
export function getSandboxExternalId(
  provider: SandboxProvider,
  reservationKey: string,
): Promise<string | null> {
  return runtime.query("getSandboxReservation", { provider: provider, reservationKey: reservationKey });
}
// The reserved sandbox plus when it was claimed, for the executors that enforce
// `lifecycle.maxLifetimeSeconds` themselves — one read instead of the id and the
// age separately. Null when the reservation is unknown.
export function getSandboxReservationRecord(
  provider: SandboxProvider,
  reservationKey: string,
): Promise<{ externalId: string; claimedAt: number } | null> {
  return runtime.query("getSandboxReservationRecord", { provider: provider, reservationKey: reservationKey });
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
