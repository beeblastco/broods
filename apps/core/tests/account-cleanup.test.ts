/** Account cleanup retry-safety tests. */

import { afterEach, expect, it } from "bun:test";
import { deleteAccountRuntimeData } from "../src/accounts/cleanup.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../src/shared/storage.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

const originalRuntimeMutate = runtime.mutate;

afterEach(() => {
  runtime.mutate = originalRuntimeMutate;
  resetStorageForTests();
});

it("propagates workspace listing failures before destructive cleanup", async () => {
  setStorageForTests({
    workspaceConfigs: {
      async list() {
        throw new Error("workspace list unavailable");
      },
    },
  } as never);

  await expect(
    deleteAccountRuntimeData({
      accountId: "acct_test",
      username: "test",
      secretHash: "hash",
      status: "disabled",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    }),
  ).rejects.toThrow("workspace list unavailable");
});

it("bounds runtime cleanup so disabled-account deletion can be retried", async () => {
  setStorageForTests({
    workspaceConfigs: {
      async list() {
        return [];
      },
      async removeAllForAccount() {
        return 0;
      },
    },
    sandboxConfigs: {
      async removeAllForAccount() {
        return 0;
      },
    },
  } as never);
  let attempts = 0;
  runtime.mutate = (async () => {
    attempts += 1;

    return {
      conversationsDeleted: 1,
      processedEventsDeleted: 0,
      asyncAgentResultDeleted: 0,
      asyncToolResultDeleted: 0,
      asyncToolGroupDeleted: 0,
      sandboxReservationDeleted: 0,
      totalDeleted: 1,
    };
  }) as never;

  await expect(
    deleteAccountRuntimeData({
      accountId: "acct_test",
      username: "test",
      secretHash: "hash",
      status: "disabled",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    }),
  ).rejects.toThrow("Account runtime cleanup exceeded 100 Convex batches");
  expect(attempts).toBe(100);
});
