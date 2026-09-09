/**
 * The sweeper's release path. Executors built from a stored config carry no
 * control-plane account, so the reservation row is dropped here, conditional on
 * the id the sweeper read, and only after the provider confirmed the teardown.
 */

import { beforeEach, expect, it, mock } from "bun:test";

const releaseMock = mock(
  async (_request: { namespace: string; expectedExternalId?: string }) => {},
);
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

class ReleasingExecutor {
  release = releaseMock;
}

for (const name of ["daytona", "e2b", "microvm", "vercel", "workdir"]) {
  mock.module(`../src/harness/sandbox/${name}-executor.ts`, () => ({
    DaytonaSandboxExecutor: ReleasingExecutor,
    E2BSandboxExecutor: ReleasingExecutor,
    MicrovmSandboxExecutor: ReleasingExecutor,
    VercelSandboxExecutor: ReleasingExecutor,
    WorkdirSandboxExecutor: ReleasingExecutor,
  }));
}
mock.module("../src/harness/sandbox/instance-store.ts", () => ({
  deleteSandboxInstance: deleteSandboxInstanceMock,
}));
mock.module("../src/shared/convex/sandbox-instances.ts", () => ({
  removeSandboxInstance: removeSandboxInstanceMock,
}));
mock.module("../src/shared/storage.ts", () => ({
  getStorage: () => ({
    sandboxConfigs: {
      list: async () => [
        { config: { provider: "lambda", persistent: true } },
        { config: { provider: "sandbox", persistent: true } },
      ],
    },
  }),
}));

const { releaseExpiredSandboxes } =
  await import("../src/shared/sandbox-cleanup.ts");

beforeEach(() => {
  releaseMock.mockClear();
  deleteSandboxInstanceMock.mockClear();
  removeSandboxInstanceMock.mockClear();
});

it("drops the row for the id it read, only once the provider tore the machine down", async () => {
  releaseMock.mockImplementationOnce(async () => {
    throw new Error("provider unreachable");
  });
  const released = await releaseExpiredSandboxes("acct-1", [
    { provider: "lambda", reservationKey: "key-a", externalId: "vm-a" },
    { provider: "sandbox", reservationKey: "key-b", externalId: "sbx-b" },
  ]);

  expect(released.map((r) => r.reservationKey)).toEqual(["key-b"]);
  expect(releaseMock.mock.calls.map((c) => c[0].expectedExternalId)).toEqual([
    "vm-a",
    "sbx-b",
  ]);
  expect(deleteSandboxInstanceMock.mock.calls).toEqual([
    ["sandbox", "key-b", "acct-1", "sbx-b"],
  ]);
  expect(removeSandboxInstanceMock.mock.calls).toEqual([["acct-1", "key-b"]]);
});
