/**
 * Sweeper orchestration. Provider teardown is covered by the executor tests; what
 * matters here is that every reservation the sweep touches ends the pass either
 * released or deferred, and that one account's failure never costs another its sweep.
 */

import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";

const releaseMock = mock(
  async (_accountId: string, reservations: unknown[]) => reservations.length,
);

// mock.module replaces the whole module, so every export its importers need is here.
mock.module("../src/shared/sandbox-cleanup.ts", () => ({
  releaseExpiredSandboxes: releaseMock,
  releaseReservedSandboxes: mock(async () => 0),
  releaseSandboxConfigInstances: mock(async () => 0),
}));

const { sweepExpiredSandboxes } = await import(
  "../src/shared/sandbox-sweeper.ts"
);

const originalQuery = runtime.query;
const originalMutate = runtime.mutate;

interface MutateCall {
  name: string;
  args: Record<string, unknown>;
}

let expired: Array<Record<string, string>> = [];
let orphans: Array<Record<string, string>> = [];
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
): Record<string, string> {
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

it("sweeps each account under its own lease and defers what it touched", async () => {
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
  expect(accountsOf("deferSandboxReservations")).toEqual(["acct-a", "acct-b"]);
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
  expect(accountsOf("deferSandboxReservations")).toEqual([
    "acct-gone",
    "acct-ok",
  ]);
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
