/**
 * In-memory stand-in for the Convex sandbox reservation table, for the opt-in
 * live sandbox tests: they drive a real provider but never read or write a
 * shared Convex deployment. Answers the same calls `instance-store.ts` makes,
 * and hides the Convex env so the best-effort registry mirror cannot connect.
 */

import { afterEach, beforeEach } from "bun:test";
import type { SandboxReleaseTarget } from "../../src/harness/sandbox/types.ts";
import { resetConvexClientForTests } from "../../src/shared/convex/client.ts";
import { runtime } from "../../src/shared/convex/runtime.ts";

const CONVEX_ENV = ["CONVEX_URL", "CONVEX_DEPLOY_KEY"] as const;
const DEFAULT_TTL_SECONDS = 3_600;

interface LiveReservation {
  externalId: string;
  claimedAt: number;
  expiresAt: number;
}

type ReservationArgs = Record<string, unknown>;

/** Swaps `runtime` onto a fresh table around each test; returns that table. */
export function useLiveReservations(): Map<string, LiveReservation> {
  const reservations = new Map<string, LiveReservation>();
  const originalMutation = runtime.mutate.bind(runtime);
  const originalQuery = runtime.query.bind(runtime);
  const originalEnv = CONVEX_ENV.map((name) => process.env[name]);

  beforeEach(() => {
    reservations.clear();
    for (const name of CONVEX_ENV) delete process.env[name];
    resetConvexClientForTests();
    runtime.mutate = ((name: string, args: ReservationArgs) =>
      Promise.resolve(mutate(reservations, name, args))) as never;
    runtime.query = ((name: string, args: ReservationArgs) =>
      Promise.resolve(query(reservations, name, args))) as never;
  });

  afterEach(() => {
    runtime.mutate = originalMutation;
    runtime.query = originalQuery;
    reservations.clear();
    CONVEX_ENV.forEach((name, index) => {
      const value = originalEnv[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
    resetConvexClientForTests();
  });

  return reservations;
}

function mutate(
  reservations: Map<string, LiveReservation>,
  name: string,
  args: ReservationArgs,
): boolean | null {
  const key = String(args.reservationKey);
  const current = reservations.get(key);
  if (name === "claimSandboxReservation") {
    if (current) return false;
    reservations.set(key, reservation(String(args.externalId), args));

    return true;
  }
  if (name === "deleteSandboxReservation") {
    const expected = args.expectedExternalId;
    if (!current) return false;
    if (expected !== undefined && current.externalId !== expected) return false;
    if (args.onlyExpired === true && current.expiresAt > nowSeconds()) {
      return false;
    }
    reservations.delete(key);

    return true;
  }
  if (name === "saveSandboxReservation") {
    if (current && current.externalId === args.externalId) {
      reservations.set(key, {
        ...reservation(current.externalId, args),
        claimedAt: current.claimedAt,
      });
    }

    return null;
  }
  throw new Error(`Unexpected live-test runtime mutation: ${name}`);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function query(
  reservations: Map<string, LiveReservation>,
  name: string,
  args: ReservationArgs,
): string | LiveReservation | SandboxReleaseTarget | null {
  const current = reservations.get(String(args.reservationKey));
  if (name === "getSandboxReservation") return current?.externalId ?? null;
  if (name === "getSandboxReservationRecord") return current ?? null;
  if (name === "getSandboxReleaseTarget") {
    const pinned =
      typeof args.externalId === "string" ? args.externalId : undefined;

    return {
      externalId: pinned ?? current?.externalId ?? null,
      instance: null,
    };
  }
  throw new Error(`Unexpected live-test runtime query: ${name}`);
}

function reservation(
  externalId: string,
  args: ReservationArgs,
): LiveReservation {
  const now = nowSeconds();
  const ttl =
    typeof args.ttlSeconds === "number" ? args.ttlSeconds : DEFAULT_TTL_SECONDS;

  return { externalId: externalId, claimedAt: now, expiresAt: now + ttl };
}
