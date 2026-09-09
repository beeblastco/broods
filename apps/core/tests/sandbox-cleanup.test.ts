/**
 * The sweeper's release path. Executors built from a stored config carry no
 * control-plane account, so the reservation row is dropped here, conditional on
 * the id the sweeper read, and only after the provider confirmed the teardown.
 * Module mocks mirror the executor suite's shapes, because bun's mock.module is
 * process-wide; storage goes through its own test seam instead.
 */

import { afterAll, beforeEach, expect, it, mock } from "bun:test";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";

const e2bKillMock = mock(async (_sandboxId: string) => {});
const deleteSandboxInstanceMock = mock(
  async (
    _provider: string,
    _key: string,
    _accountId: string | undefined,
    _externalId?: string,
  ) => {},
);
const removeSandboxInstanceMock = mock(
  async (_accountId: string, _key: string) => {},
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
  claimSandboxInstance: mock(async () => true),
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
  deleteSandboxInstanceMock.mockClear();
  removeSandboxInstanceMock.mockClear();
});

it("drops the row for the id it read, only once the provider tore the machine down", async () => {
  e2bKillMock.mockImplementationOnce(async () => {
    throw new Error("connection reset");
  });
  const released = await releaseExpiredSandboxes("acct-1", [
    { provider: "e2b", reservationKey: "key-a", externalId: "sbx-a" },
    { provider: "e2b", reservationKey: "key-b", externalId: "sbx-b" },
  ]);

  expect(released.map((r) => r.reservationKey)).toEqual(["key-b"]);
  expect(e2bKillMock.mock.calls.map((c) => c[0])).toEqual(["sbx-a", "sbx-b"]);
  // The executor's own delete has no account and is a no-op; the sweeper's carries it.
  expect(
    deleteSandboxInstanceMock.mock.calls.filter((c) => c[2] !== undefined),
  ).toEqual([["e2b", "key-b", "acct-1", "sbx-b"]]);
  expect(removeSandboxInstanceMock.mock.calls).toEqual([["acct-1", "key-b"]]);
});
