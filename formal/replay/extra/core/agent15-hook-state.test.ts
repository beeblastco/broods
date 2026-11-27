import { describe, expect, mock, test } from "bun:test";

import type { AccountHookRecord } from "../../../../apps/core/src/shared/domain/account-hooks.ts";

const S3_PATH = import.meta.resolve("../../../../apps/core/src/shared/s3.ts");
const EXECUTOR_PATH = import.meta
  .resolve("../../../../apps/core/src/harness/isolate/executor.ts");
const realS3 = await import(S3_PATH);
const realExecutor = await import(EXECUTOR_PATH);

process.env.TOOL_BUNDLES_BUCKET_NAME = "hook-state-fixture";

let finalValue: unknown;

await mock.module(S3_PATH, (): object => ({
  ...realS3,
  readS3Bytes: async (): Promise<Uint8Array> => new TextEncoder().encode("x"),
}));
await mock.module(EXECUTOR_PATH, (): object => ({
  ...realExecutor,
  streamIsolatePayload: async function* (): AsyncGenerator<unknown> {
    yield finalValue;
  },
}));

const { runCodeHook } =
  await import("../../../../apps/core/src/harness/hook-runner.ts");

const SHA = new Bun.CryptoHasher("sha256").update("x").digest("hex");
const RECORD: AccountHookRecord = {
  accountId: "acct_state",
  hookId: "hook_state",
  name: "state",
  events: ["agent.started"],
  bundleStorageKey: "account-hooks/acct_state/1",
  sha256: SHA,
  status: "active",
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
};
const INCOMING = { before: 1 };

async function stateAfter(returned: unknown): Promise<unknown> {
  finalValue = returned;
  const outcome = await runCodeHook({
    accountId: "acct_state",
    record: RECORD,
    event: "agent.started",
    payload: {},
    config: {} as Parameters<typeof runCodeHook>[0]["config"],
    state: INCOMING,
  });

  return outcome.state;
}

describe("sanitizeHookState", (): void => {
  test("keeps the state a hook returns", async (): Promise<void> => {
    expect(await stateAfter({ state: { count: 2 } })).toEqual({ count: 2 });
  });

  test("keeps an empty state", async (): Promise<void> => {
    expect(await stateAfter({ state: {} })).toEqual({});
  });

  test("falls back when the state is not an object", async (): Promise<void> => {
    expect(await stateAfter({ state: "oops" })).toEqual(INCOMING);
    expect(await stateAfter({ result: {} })).toEqual(INCOMING);
  });

  test("falls back when the state is over the size cap", async (): Promise<void> => {
    const big = { blob: "y".repeat(200 * 1024) };

    expect(await stateAfter({ state: big })).toEqual(INCOMING);
  });
});
