/**
 * Sweeper orchestration. Provider teardown is covered by the executor tests; what
 * matters here is that every reservation the sweep touches ends the pass either
 * released or deferred, and that one account's failure never costs another its sweep.
 */

import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";
import type { SandboxReservationRef } from "../src/shared/sandbox-cleanup.ts";

// Returns what it released, so the sweeper can tell the released rows from the
// ones it still has to defer. Everything handed in is released by default; a test
// that wants a survivor overrides this.
const releaseMock = mock(
  async (
    _accountId: string,
    reservations: SandboxReservationRef[],
  ): Promise<SandboxReservationRef[]> => reservations,
);

// mock.module replaces the whole module, so every export its importers need is here.
mock.module("../src/shared/sandbox-cleanup.ts", () => ({
  releaseExpiredSandboxes: releaseMock,
  releaseReservedSandboxes: mock(async () => 0),
  releaseSandboxConfigInstances: mock(async () => 0),
}));

const { sweepExpiredSandboxes } =
  await import("../src/shared/sandbox-sweeper.ts");

const originalQuery = runtime.query;
const originalMutate = runtime.mutate;

interface MutateCall {
  name: string;
  args: Record<string, unknown>;
}

type ExpiredReservation = SandboxReservationRef & {
  accountId: string;
  externalId: string;
};

let expired: ExpiredReservation[] = [];
let orphans: ExpiredReservation[] = [];
let mutateCalls: MutateCall[] = [];
let adoptResult = true;
let leaseResult: (accountId: string) => boolean = () => true;

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
  orphans = [];
  mutateCalls = [];
  adoptResult = true;
  leaseResult = () => true;
  releaseMock.mockClear();
  runtime.query = (async (name: string) =>
    name === "listExpiredSandboxReservations" ? expired : orphans) as never;
  runtime.mutate = (async (name: string, args: Record<string, unknown>) => {
    mutateCalls.push({ name: name, args: args });
    if (name === "claimEvent") return leaseResult(String(args.accountId));
    if (name === "claimSandboxReservation") return adoptResult;

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
  // Everything was released, so there is nothing left to hold off.
  expect(accountsOf("deferSandboxReservations")).toEqual([]);
});

it("defers only what it could not release", async () => {
  // Deferring a released reservation would push its expiry forward and hide it
  // from the next pass, which is the opposite of what the sweep is for.
  expired = [
    reservation("acct-a", "ns-kept"),
    reservation("acct-a", "ns-gone"),
  ];
  releaseMock.mockImplementationOnce(
    async (
      _accountId: string,
      reservations: SandboxReservationRef[],
    ): Promise<SandboxReservationRef[]> =>
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
  // acct-ok released everything, so only the account that never got its lease
  // still has rows that would otherwise hold the head of the expiry page.
  expect(accountsOf("deferSandboxReservations")).toEqual(["acct-gone"]);
});

it("leaves an account another replica already holds to that replica", async () => {
  expired = [reservation("acct-a", "ns-1")];
  leaseResult = () => false;

  expect(await sweepExpiredSandboxes()).toBe(0);
  expect(releaseMock).not.toHaveBeenCalled();
  expect(accountsOf("deferSandboxReservations")).toEqual([]);
});

it("adopts an orphaned mirror row so the normal teardown can reach it", async () => {
  orphans = [reservation("acct-a", "ns-orphan")];

  expect(await sweepExpiredSandboxes()).toBe(1);
  expect(
    mutateCalls
      .filter((call) => call.name === "claimSandboxReservation")
      .map((call) => call.args.externalId),
  ).toEqual(["sbx-ns-orphan"]);
  expect(releaseMock.mock.calls[0]?.[1]).toEqual([
    reservation("acct-a", "ns-orphan"),
  ]);
});

it("skips an orphan whose reservation reappeared", async () => {
  orphans = [reservation("acct-a", "ns-orphan")];
  adoptResult = false;

  expect(await sweepExpiredSandboxes()).toBe(0);
  expect(releaseMock).not.toHaveBeenCalled();
});
