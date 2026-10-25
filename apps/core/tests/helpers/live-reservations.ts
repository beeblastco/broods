/**
 * In-memory stand-in for the Convex sandbox reservation table, for the opt-in
 * live sandbox tests: they drive a real provider but never read or write a
 * shared Convex deployment. Answers the same calls `instance-store.ts` makes,
 * and hides the Convex env so the best-effort registry mirror cannot connect.
 */

import { afterEach, beforeEach } from "bun:test";
import { resetConvexClientForTests } from "../../src/shared/convex/client.ts";
import { runtime } from "../../src/shared/convex/runtime.ts";

const CONVEX_ENV = ["CONVEX_URL", "CONVEX_DEPLOY_KEY"] as const;
const DEFAULT_TTL_SECONDS = 3_600;

type ReservationQuery =
  | "getSandboxReleaseTarget"
  | "getSandboxReservation"
  | "getSandboxReservationRecord";
type ReservationMutation =
  | "claimSandboxReservation"
  | "deleteSandboxReservation"
  | "saveSandboxReservation";
type QueryArgs<Name extends ReservationQuery> = Parameters<
  typeof runtime.query<Name>
>[1];
type QueryResult<Name extends ReservationQuery> = Awaited<
  ReturnType<typeof runtime.query<Name>>
>;
type MutationArgs<Name extends ReservationMutation> = Parameters<
  typeof runtime.mutate<Name>
>[1];
type MutationResult<Name extends ReservationMutation> = Awaited<
  ReturnType<typeof runtime.mutate<Name>>
>;
type LiveReservation = NonNullable<QueryResult<"getSandboxReservationRecord">>;
type ReservationTable = Map<string, LiveReservation>;

const queries: {
  [Name in ReservationQuery]: (
    table: ReservationTable,
    args: QueryArgs<Name>,
  ) => QueryResult<Name>;
} = {
  getSandboxReleaseTarget: (table, args) => ({
    externalId:
      args.externalId ?? table.get(args.reservationKey)?.externalId ?? null,
    instance: null,
  }),
  getSandboxReservation: (table, args) =>
    table.get(args.reservationKey)?.externalId ?? null,
  getSandboxReservationRecord: (table, args) =>
    table.get(args.reservationKey) ?? null,
};

const mutations: {
  [Name in ReservationMutation]: (
    table: ReservationTable,
    args: MutationArgs<Name>,
  ) => MutationResult<Name>;
} = {
  claimSandboxReservation: (table, args) => {
    if (table.has(args.reservationKey)) return false;
    table.set(
      args.reservationKey,
      reservation(args.externalId, args.ttlSeconds),
    );

    return true;
  },
  // True hands the caller the teardown, as the real mutation does.
  deleteSandboxReservation: (table, args) => {
    const current = table.get(args.reservationKey);
    if (!current) return false;
    if (
      args.expectedExternalId !== undefined &&
      current.externalId !== args.expectedExternalId
    ) {
      return false;
    }
    if (args.onlyExpired === true && current.expiresAt > nowSeconds()) {
      return false;
    }
    table.delete(args.reservationKey);

    return true;
  },
  // Refreshes the deadline only; never creates or repoints a row.
  saveSandboxReservation: (table, args) => {
    const current = table.get(args.reservationKey);
    if (current && current.externalId === args.externalId) {
      table.set(args.reservationKey, {
        ...reservation(current.externalId, args.ttlSeconds),
        claimedAt: current.claimedAt,
      });
    }

    return null;
  },
};

/** Swaps `runtime` onto a fresh table around each test; returns that table. */
export function useLiveReservations(): ReservationTable {
  const table: ReservationTable = new Map();
  const originalMutation = runtime.mutate.bind(runtime);
  const originalQuery = runtime.query.bind(runtime);
  const originalEnv = CONVEX_ENV.map((name) => process.env[name]);

  beforeEach(() => {
    table.clear();
    for (const name of CONVEX_ENV) delete process.env[name];
    resetConvexClientForTests();
    // The one untyped seam: the generic runtime dispatches by name, and these
    // maps answer only the reservation calls.
    runtime.query = ((name: ReservationQuery, args: never) =>
      Promise.resolve(callHandler(queries, name, table, args))) as never;
    runtime.mutate = ((name: ReservationMutation, args: never) =>
      Promise.resolve(callHandler(mutations, name, table, args))) as never;
  });

  afterEach(() => {
    runtime.mutate = originalMutation;
    runtime.query = originalQuery;
    table.clear();
    CONVEX_ENV.forEach((name, index) => {
      const value = originalEnv[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
    resetConvexClientForTests();
  });

  return table;
}

function callHandler(
  handlers: Record<string, (table: ReservationTable, args: never) => unknown>,
  name: string,
  table: ReservationTable,
  args: never,
): unknown {
  const handler = handlers[name];
  if (!handler) throw new Error(`Unexpected live-test runtime call: ${name}`);

  return handler(table, args);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function reservation(
  externalId: string,
  ttlSeconds: number | undefined,
): LiveReservation {
  const now = nowSeconds();

  return {
    externalId: externalId,
    claimedAt: now,
    expiresAt: now + (ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
}
