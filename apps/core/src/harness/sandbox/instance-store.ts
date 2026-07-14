/** Authoritative Convex mapping from sandbox reservations to provider ids. */

import {
  runtimeMutation,
  runtimeQuery,
} from "../../shared/convex/runtime.ts";
import type { SandboxProvider } from "./types.ts";
export function getSandboxExternalId(
  provider: SandboxProvider,
  reservationKey: string,
): Promise<string | null> {
  return runtimeQuery("getSandboxReservation", { provider, reservationKey });
}
export function claimSandboxInstance(
  provider: SandboxProvider,
  reservationKey: string,
  externalId: string,
): Promise<boolean> {
  return runtimeMutation("claimSandboxReservation", {
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
  await runtimeMutation("saveSandboxReservation", {
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
  await runtimeMutation("deleteSandboxReservation", {
    provider,
    reservationKey,
    expectedExternalId,
  });
}
