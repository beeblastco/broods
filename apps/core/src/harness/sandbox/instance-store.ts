/** Authoritative Convex mapping from sandbox reservations to provider ids. */

import { runtime } from "../../shared/convex/runtime.ts";
import type { SandboxProvider } from "./types.ts";
export function getSandboxExternalId(
  provider: SandboxProvider,
  reservationKey: string,
): Promise<string | null> {
  return runtime.query("getSandboxReservation", { provider, reservationKey });
}
export function claimSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
): Promise<boolean> {
  return runtime.mutate("claimSandboxReservation", {
    provider,
    reservationKey,
    externalId,
  });
}
export async function saveSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
): Promise<void> {
  await runtime.mutate("saveSandboxReservation", {
    provider,
    reservationKey,
    externalId,
  });
}
export async function deleteSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  expectedExternalId?: string,
): Promise<void> {
  await runtime.mutate("deleteSandboxReservation", {
    provider,
    reservationKey,
    expectedExternalId,
  });
}
