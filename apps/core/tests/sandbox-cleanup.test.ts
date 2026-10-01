/**
 * The sweeper's release path. The reservation row is taken first, conditional on
 * the id and deadline the sweeper read, so a run that reconnected in between keeps
 * its machine; only then is the provider teardown attempted, and the mirror row
 * dropped for that same id. Module mocks mirror the executor suite's shapes,
 * because bun's mock.module is process-wide; storage goes through its own test
 * seam instead.
 */

import { afterAll, beforeEach, expect, it, mock } from "bun:test";
import type { SandboxReleaseTarget } from "../src/harness/sandbox/types.ts";
import type { SandboxConfigRecord } from "../src/shared/domain/sandbox-config.ts";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";

const PLATFORM_ROW: SandboxReleaseTarget["instance"] = {
  ownCredentials: false,
};
let accountConfigs: SandboxConfigRecord[] = [];
let instanceRow: SandboxReleaseTarget["instance"] = PLATFORM_ROW;
let reservedProvider = "e2b";
let lookupError: Error | undefined;

const e2bKillMock = mock(
  async (_sandboxId: string, _options?: { apiKey?: string }) => {},
);
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
const getSandboxExternalIdMock = mock(
  async (_provider: string, _key: string): Promise<string | null> => null,
);
const removeSandboxInstanceMock = mock(
  async (
    _accountId: string,
    _key: string,
    _externalId?: string,
  ): Promise<void> => {},
);

const microvmSendMock = mock(
  async (_command: { input: { microvmIdentifier?: string } }) => ({}),
);
// The executor builds one command per call; only the terminate is sent here.
class TerminateMicrovmCommand {
  input: { microvmIdentifier?: string };
  constructor(input: { microvmIdentifier?: string }) {
    this.input = input;
  }
}

mock.module("@aws-sdk/client-lambda-microvms", () => ({
  LambdaMicrovms: class {
    send = microvmSendMock;
  },
  CreateMicrovmAuthTokenCommand: TerminateMicrovmCommand,
  CreateMicrovmShellAuthTokenCommand: TerminateMicrovmCommand,
  GetMicrovmCommand: TerminateMicrovmCommand,
  ResumeMicrovmCommand: TerminateMicrovmCommand,
  RunMicrovmCommand: TerminateMicrovmCommand,
  SuspendMicrovmCommand: TerminateMicrovmCommand,
  TerminateMicrovmCommand: TerminateMicrovmCommand,
}));
mock.module("e2b", () => ({
  Sandbox: {
    create: mock(async () => {}),
    connect: mock(async () => {}),
    kill: e2bKillMock,
  },
}));
// The reserved id is the one passed, or "sbx-live" for the one provider that
// holds a machine.
const getSandboxReleaseTargetMock = mock(
  async (
    _accountId: string,
    provider: string,
    _key: string,
    externalId?: string,
  ): Promise<SandboxReleaseTarget> => {
    if (lookupError) throw lookupError;
    if (provider !== reservedProvider) {
      return { externalId: null, instance: null };
    }

    return { externalId: externalId ?? "sbx-live", instance: instanceRow };
  },
);

mock.module("../src/harness/sandbox/instance-store.ts", () => ({
  getSandboxExternalId: getSandboxExternalIdMock,
  getSandboxReleaseTarget: getSandboxReleaseTargetMock,
  getSandboxReservationRecord: mock(async () => null),
  claimSandboxInstance: claimSandboxInstanceMock,
  saveSandboxInstance: mock(async () => {}),
  deleteSandboxInstance: deleteSandboxInstanceMock,
}));
mock.module("../src/shared/convex/sandbox-instances.ts", () => ({
  recordSandboxBurst: mock(async () => true),
  removeSandboxInstance: removeSandboxInstanceMock,
  sandboxInstanceIsControllable: mock(async () => true),
  setSandboxInstanceStatus: mock(async () => true),
  upsertSandboxInstance: mock(async () => {}),
}));

const { releaseExpiredSandboxes, releaseReservedSandboxes } =
  await import("../src/shared/sandbox-cleanup.ts");

setStorageForTests({
  sandboxConfigs: { list: async () => accountConfigs },
} as unknown as Storage);

afterAll(() => {
  setStorageForTests(null);
});

beforeEach(() => {
  accountConfigs = [record("cfg-e2b", { provider: "e2b", persistent: true })];
  instanceRow = PLATFORM_ROW;
  reservedProvider = "e2b";
  lookupError = undefined;
  e2bKillMock.mockReset();
  claimSandboxInstanceMock.mockClear();
  deleteSandboxInstanceMock.mockClear();
  removeSandboxInstanceMock.mockClear();
});

it("takes the row for the id it read before the teardown, and drops the mirror only once the provider confirmed", async () => {
  // Fails through the config and the platform's credentials alike.
  e2bKillMock.mockImplementation(async (sandboxId: string) => {
    if (sandboxId === "sbx-a") throw new Error("connection reset");
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
  expect(e2bKillMock.mock.calls.map((c) => c[0])).toEqual([
    "sbx-a",
    "sbx-a",
    "sbx-b",
  ]);
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

// Turning `persistent` off or switching provider leaves the machine where it
// was, so the release follows the provider the reservation names.
it("releases through a config that is no longer persistent", async () => {
  accountConfigs = [record("cfg-e2b", { provider: "e2b", persistent: false })];
  const released = await releaseExpiredSandboxes("acct-1", [
    { provider: "e2b", reservationKey: "key-a", externalId: "sbx-a" },
  ]);

  expect(released.map((r) => r.reservationKey)).toEqual(["key-a"]);
  expect(e2bKillMock.mock.calls.map((c) => c[0])).toEqual(["sbx-a"]);
});

it("falls back to the platform's credentials after a provider switch", async () => {
  accountConfigs = [
    record("cfg-e2b", { provider: "lambda", persistent: true }),
  ];
  const released = await releaseExpiredSandboxes("acct-1", [
    { provider: "e2b", reservationKey: "key-a", externalId: "sbx-a" },
  ]);

  expect(released.map((r) => r.reservationKey)).toEqual(["key-a"]);
  expect(e2bKillMock.mock.calls.map((c) => c[0])).toEqual(["sbx-a"]);
});

// A release reads a 404 as "already gone", so another account's credentials
// would drop a live machine's rows.
it("releases a tenant's machine only through the config that reserved it", async () => {
  instanceRow = { ownCredentials: true, sandboxConfigId: "cfg-mine" };
  accountConfigs = [
    record("cfg-other", { provider: "e2b", options: { apiKey: "key-other" } }),
    record("cfg-mine", { provider: "e2b", options: { apiKey: "key-mine" } }),
  ];
  const released = await releaseExpiredSandboxes("acct-1", [
    { provider: "e2b", reservationKey: "key-a", externalId: "sbx-a" },
  ]);

  expect(released.map((r) => r.reservationKey)).toEqual(["key-a"]);
  expect(e2bKillMock.mock.calls.map((c) => c[1]?.apiKey)).toEqual(["key-mine"]);
});

it("never tries the platform's credentials on a tenant's machine", async () => {
  instanceRow = { ownCredentials: true, sandboxConfigId: "cfg-e2b" };
  accountConfigs = [
    record("cfg-e2b", { provider: "lambda", persistent: true }),
  ];
  const released = await releaseExpiredSandboxes("acct-1", [
    { provider: "e2b", reservationKey: "key-a", externalId: "sbx-a" },
  ]);

  expect(released).toEqual([]);
  expect(e2bKillMock).not.toHaveBeenCalled();
  expect(claimSandboxInstanceMock.mock.calls).toEqual([
    ["e2b", "key-a", "sbx-a", "acct-1"],
  ]);
});

it("keeps to the account's configs when no instance row says whose machine it is", async () => {
  instanceRow = null;
  accountConfigs = [
    record("cfg-e2b", { provider: "lambda", persistent: true }),
  ];
  const released = await releaseExpiredSandboxes("acct-1", [
    { provider: "e2b", reservationKey: "key-a", externalId: "sbx-a" },
  ]);

  expect(released).toEqual([]);
  expect(e2bKillMock).not.toHaveBeenCalled();
});

// A MicroVM only ever runs on the platform's AWS role, so it needs no row to say so.
it("releases a MicroVM through the platform's credentials with no instance row", async () => {
  instanceRow = null;
  reservedProvider = "lambda";
  accountConfigs = [];
  microvmSendMock.mockClear();
  const released = await releaseExpiredSandboxes("acct-1", [
    { provider: "lambda", reservationKey: "key-a", externalId: "mvm-a" },
  ]);

  expect(released.map((r) => r.reservationKey)).toEqual(["key-a"]);
  expect(
    microvmSendMock.mock.calls.map((c) => c[0].input.microvmIdentifier),
  ).toEqual(["mvm-a"]);
});

// Account delete disables the account before it releases, and Convex refuses a
// row take on a disabled account. The machine goes down anyway, by the id the
// stored row names; the cascade drops the row.
it("tears down a live reservation when the row take is refused", async () => {
  deleteSandboxInstanceMock.mockImplementation(async (): Promise<boolean> => {
    throw new Error("Account is not active: acct-1");
  });

  const released = await releaseReservedSandboxes("acct-1", ["key-live"]);
  deleteSandboxInstanceMock.mockImplementation(
    async (): Promise<boolean> => true,
  );

  expect(released).toBe(1);
  expect(e2bKillMock.mock.calls.map((c) => c[0])).toEqual(["sbx-live"]);
  expect(removeSandboxInstanceMock.mock.calls).toEqual([
    ["acct-1", "key-live", undefined],
  ]);
});

it("still drops the rows when the reservation lookup fails", async () => {
  lookupError = new Error("convex unavailable");
  const released = await releaseReservedSandboxes("acct-1", ["key-live"]);

  expect(released).toBe(0);
  expect(e2bKillMock).not.toHaveBeenCalled();
  expect(removeSandboxInstanceMock.mock.calls).toEqual([
    ["acct-1", "key-live", undefined],
  ]);
});

function record(
  sandboxId: string,
  config: SandboxConfigRecord["config"],
): SandboxConfigRecord {
  return {
    accountId: "acct-1",
    sandboxId: sandboxId,
    name: sandboxId,
    config: config,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}
