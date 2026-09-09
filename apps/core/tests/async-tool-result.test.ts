/**
 * The fence between a detached job's callback and the sandbox it launched on.
 * The Convex side is covered in packages/convex; this pins the core decision.
 */

import { beforeEach, expect, it, mock } from "bun:test";

let reservedId: string | null = "sbx-current";
const getSandboxExternalIdMock = mock(
  async (_provider: string, _key: string) => reservedId,
);

// mock.module is process-wide in bun, and the executor suite replaces this module
// too, so the fence is pinned to its own lookup rather than to whichever mock
// happens to be installed when this file runs.
mock.module("../src/harness/sandbox/instance-store.ts", () => ({
  getSandboxExternalId: getSandboxExternalIdMock,
}));

const { asyncToolSandboxStillReserved } =
  await import("../src/harness/async-tool-result.ts");

const sandbox = {
  provider: "sandbox" as const,
  reservationKey: "acct:one:workspace:one",
  externalId: "sbx-current",
};

beforeEach(() => {
  getSandboxExternalIdMock.mockClear();
});

it("passes a job that reported before its launch was recorded", async () => {
  expect(await asyncToolSandboxStillReserved({})).toBe(true);
  expect(getSandboxExternalIdMock).not.toHaveBeenCalled();
});

it("passes while the reservation still names the job's sandbox", async () => {
  reservedId = "sbx-current";
  expect(await asyncToolSandboxStillReserved({ sandbox: sandbox })).toBe(true);
});

it("refuses a report from a sandbox the reservation replaced or released", async () => {
  reservedId = "sbx-replacement";
  expect(await asyncToolSandboxStillReserved({ sandbox: sandbox })).toBe(false);
  reservedId = null;
  expect(await asyncToolSandboxStillReserved({ sandbox: sandbox })).toBe(false);
});
