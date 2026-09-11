/**
 * The sweeper's release path. The reservation row is taken first, conditional on
 * the id and deadline the sweeper read, so a run that reconnected in between keeps
 * its machine; only then is the provider teardown attempted, and the mirror row
 * dropped for that same id. Module mocks mirror the executor suite's shapes,
 * because bun's mock.module is process-wide; storage goes through its own test
 * seam instead.
 */

import { afterAll, beforeEach, expect, it, mock } from "bun:test";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";

const e2bKillMock = mock(async (_sandboxId: string) => {});
const claimSandboxInstanceMock = mock(
  async (
    _provider: string,
    _key: string,
    _externalId: string,
    _accountId: string | undefined,
  ): Promise<boolean> => true,
);
const deleteSandboxInstanceMock = mock(
  async (
    _provider: string,
    _key: string,
    _accountId: string | undefined,
    _externalId?: string,
    _onlyExpired?: boolean,
  ): Promise<boolean> => true,
);
const removeSandboxInstanceMock = mock(
  async (
    _accountId: string,
    _key: string,
    _externalId?: string,
  ): Promise<void> => {},
);

mock.module("e2b", () => ({
  Sandbox: {
    create: mock(async () => {}),
    connect: mock(async () => {}),
    kill: e2bKillMock,
  },
}));
mock.module("../src/harness/sandbox/instance-store.ts", () => ({
  getSandboxExternalId: mock(async () => null),
  getSandboxReservationRecord: mock(async () => null),
  claimSandboxInstance: claimSandboxInstanceMock,
  saveSandboxInstance: mock(async () => {}),
  deleteSandboxInstance: deleteSandboxInstanceMock,
}));
mock.module("../src/shared/convex/sandbox-instances.ts", () => ({
  removeSandboxInstance: removeSandboxInstanceMock,
  upsertSandboxInstance: mock(async () => {}),
}));

const { releaseExpiredSandboxes } =
  await import("../src/shared/sandbox-cleanup.ts");

setStorageForTests({
  sandboxConfigs: {
    list: async () => [{ config: { provider: "e2b", persistent: true } }],
  },
} as unknown as Storage);

afterAll(() => {
  setStorageForTests(null);
});

beforeEach(() => {
  e2bKillMock.mockClear();
  claimSandboxInstanceMock.mockClear();
  deleteSandboxInstanceMock.mockClear();
  removeSandboxInstanceMock.mockClear();
});

it("takes the row for the id it read before the teardown, and drops the mirror only once the provider confirmed", async () => {
  e2bKillMock.mockImplementationOnce(async () => {
    throw new Error("connection reset");
  });
  const released = await releaseExpiredSandboxes("acct-1", [
    { provider: "e2b", reservationKey: "key-a", externalId: "sbx-a" },
    { provider: "e2b", reservationKey: "key-b", externalId: "sbx-b" },
  ]);

  expect(released.map((r) => r.reservationKey)).toEqual(["key-b"]);
  // The executor's own row delete inside release carries no account and is a
  // no-op; the sweeper's take is the one with the expiry condition.
  expect(
    deleteSandboxInstanceMock.mock.calls.filter((c) => c[4] === true),
  ).toEqual([
    ["e2b", "key-a", "acct-1", "sbx-a", true],
    ["e2b", "key-b", "acct-1", "sbx-b", true],
  ]);
  expect(e2bKillMock.mock.calls.map((c) => c[0])).toEqual(["sbx-a", "sbx-b"]);
  // The mirror row is what keeps a failed teardown reachable for the next sweep,
  // so only the confirmed one goes, and only while it still names that machine.
  expect(removeSandboxInstanceMock.mock.calls).toEqual([
    ["acct-1", "key-b", "sbx-b"],
  ]);
  // The failed one gets its row back, so the sweeper can defer the retry.
  expect(claimSandboxInstanceMock.mock.calls).toEqual([
    ["e2b", "key-a", "sbx-a", "acct-1"],
  ]);
});

it("leaves a machine alone when a run refreshed its reservation since the listing", async () => {
  deleteSandboxInstanceMock.mockImplementationOnce(async () => false);
  const released = await releaseExpiredSandboxes("acct-1", [
    { provider: "e2b", reservationKey: "key-a", externalId: "sbx-a" },
  ]);

  expect(released).toEqual([]);
  expect(e2bKillMock).not.toHaveBeenCalled();
  expect(removeSandboxInstanceMock).not.toHaveBeenCalled();
});
