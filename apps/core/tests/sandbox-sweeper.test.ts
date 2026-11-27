import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import type { ReservedSandbox } from "../src/harness/sandbox/types.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

const releaseMock = mock(
  async (
    _accountId: string,
    reservations: ReservedSandbox[],
  ): Promise<ReservedSandbox[]> => reservations,
);

// mock.module replaces the whole module, so every export its importers need is here.
await mock.module("../src/shared/sandbox-cleanup.ts", () => ({
  releaseExpiredSandboxes: releaseMock,
  releaseReservedSandboxes: mock(async () => 0),
}));

const { sweepExpiredSandboxes } =
  await import("../src/shared/sandbox-sweeper.ts");

const originalQuery = runtime.query.bind(runtime);
const originalMutate = runtime.mutate.bind(runtime);

interface MutateCall {
  name: string;
  args: Record<string, unknown>;
}

type ExpiredReservation = ReservedSandbox & { accountId: string };

let expired: ExpiredReservation[] = [];
let orphanPages: ExpiredReservation[][] = [[]];
let orphanCursors: unknown[] = [];
let mutateCalls: MutateCall[] = [];
let leaseResult: (accountId: string) => boolean = (
  _accountId: string,
): boolean => true;

function accountsOf(name: string): unknown[] {
  return mutateCalls
    .filter((call) => call.name === name)
    .map((call) => call.args.accountId);
}

function reservation(
  accountId: string,
  reservationKey: string,
): ExpiredReservation {
  return {
    accountId: accountId,
    provider: "sandbox",
    reservationKey: reservationKey,
    externalId: `sbx-${reservationKey}`,
  };
}

beforeEach(() => {
  expired = [];
  orphanPages = [[]];
  orphanCursors = [];
  mutateCalls = [];
  leaseResult = (_accountId: string): boolean => true;
  releaseMock.mockClear();
  runtime.query = (async (name: string, args: Record<string, unknown>) => {
    if (name === "listExpiredSandboxReservations") return expired;
    orphanCursors.push(args.cursor);
    const index = args.cursor === null ? 0 : Number(args.cursor);
    const isDone = index + 1 >= orphanPages.length;

    return {
      page: orphanPages[index],
      cursor: isDone ? null : String(index + 1),
      isDone: isDone,
    };
  }) as never;
  runtime.mutate = (async (name: string, args: Record<string, unknown>) => {
    mutateCalls.push({ name: name, args: args });
    if (name === "claimEvent") return leaseResult(String(args.accountId));

    return 0;
  }) as never;
});

afterEach(() => {
  runtime.query = originalQuery;
  runtime.mutate = originalMutate;
});

it("sweeps each account under its own lease", async () => {
  expired = [
    reservation("acct-a", "ns-1"),
    reservation("acct-b", "ns-2"),
    reservation("acct-a", "ns-3"),
  ];

  expect(await sweepExpiredSandboxes()).toBe(3);
  expect(releaseMock.mock.calls.map((call) => call[0])).toEqual([
    "acct-a",
    "acct-b",
  ]);
  expect(releaseMock.mock.calls[0]?.[1]).toHaveLength(2);
  expect(accountsOf("claimEvent")).toEqual(["acct-a", "acct-b"]);
  expect(accountsOf("deferSandboxReservations")).toEqual([]);
  expect(accountsOf("releaseClaim")).toEqual(["acct-a", "acct-b"]);
});

it("defers only what it could not release", async () => {
  // Deferring a released reservation would push its expiry forward and hide it from the sweep.
  expired = [
    reservation("acct-a", "ns-kept"),
    reservation("acct-a", "ns-gone"),
  ];
  releaseMock.mockImplementationOnce(
    async (
      _accountId: string,
      reservations: ReservedSandbox[],
    ): Promise<ReservedSandbox[]> =>
      reservations.filter((one) => one.reservationKey === "ns-gone"),
  );

  expect(await sweepExpiredSandboxes()).toBe(1);
  const deferred = mutateCalls.find(
    (call) => call.name === "deferSandboxReservations",
  );
  expect(deferred?.args.reservations).toEqual([
    { provider: "sandbox", reservationKey: "ns-kept" },
  ]);
});

it("defers an account whose lease is refused so its rows stop blocking the page", async () => {
  expired = [reservation("acct-gone", "ns-1"), reservation("acct-ok", "ns-2")];
  leaseResult = (accountId) => {
    // claimEvent requires an active account, so a suspended one throws here.
    if (accountId === "acct-gone") throw new Error("Account is not active");

    return true;
  };

  expect(await sweepExpiredSandboxes()).toBe(1);
  expect(releaseMock.mock.calls.map((call) => call[0])).toEqual(["acct-ok"]);
  expect(accountsOf("deferSandboxReservations")).toEqual(["acct-gone"]);
});

it("leaves an account another replica already holds to that replica", async () => {
  expired = [reservation("acct-a", "ns-1")];
  leaseResult = (_accountId: string): boolean => false;

  expect(await sweepExpiredSandboxes()).toBe(0);
  expect(releaseMock).not.toHaveBeenCalled();
  expect(accountsOf("deferSandboxReservations")).toEqual([]);
  // Never held, so never released: that would free the other replica's lease.
  expect(accountsOf("releaseClaim")).toEqual([]);
});

it("hands an orphaned mirror row to the same teardown, by the id it still holds", async () => {
  orphanPages = [[reservation("acct-a", "ns-orphan")]];

  expect(await sweepExpiredSandboxes()).toBe(1);
  expect(releaseMock.mock.calls[0]?.[1]).toEqual([
    reservation("acct-a", "ns-orphan"),
  ]);
});

it("reads on past pages of reserved mirrors to the orphans behind them", async () => {
  // Mirrors a deferred reservation names keep their age, so they can fill the oldest pages.
  orphanPages = [[], [], [reservation("acct-a", "ns-orphan")]];

  expect(await sweepExpiredSandboxes()).toBe(1);
  expect(orphanCursors).toEqual([null, "1", "2"]);
});

it("stops reading once a page's worth of orphans is found", async () => {
  orphanPages = [
    Array.from({ length: 100 }, (_, index) =>
      reservation("acct-a", `ns-${index}`),
    ),
    [reservation("acct-a", "ns-next")],
  ];

  expect(await sweepExpiredSandboxes()).toBe(100);
  expect(orphanCursors).toEqual([null]);
});
