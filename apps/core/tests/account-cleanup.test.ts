/** Account cleanup retry-safety tests. */

import { afterEach, expect, it } from "bun:test";
import { getFunctionName } from "convex/server";
import { deleteAccountRuntimeData } from "../src/accounts/cleanup.ts";
import {
  getConvexClient,
  resetConvexClientForTests,
} from "../src/shared/convex/client.ts";
import { convexStorage } from "../src/shared/convex/storage.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../src/shared/storage.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

const originalRuntimeMutate = runtime.mutate;

afterEach(() => {
  runtime.mutate = originalRuntimeMutate;
  resetConvexClientForTests();
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

// awsCrons.remove is the action that deletes the EventBridge schedule and the
// row together; assert it is a registered internal action at the expected path.
it("registers awsCrons.remove as an internal action", () => {
  const registered = require("@broods/convex/awsCrons") as Record<
    string,
    { isInternal?: boolean; isAction?: boolean } | undefined
  >;
  const internal = require("@broods/convex/_generated/api").internal;

  expect(registered.remove).toMatchObject({ isInternal: true, isAction: true });
  expect(getFunctionName(internal.awsCrons.remove)).toBe("awsCrons:remove");
});

// The adapter reaches this reference through an any-typed require, so nothing but
// this check catches a rewire that stops deleting EventBridge schedules.
it("crons.remove delegates to internal.awsCrons.remove via action", async () => {
  process.env.CONVEX_URL ||= "https://example.convex.cloud";
  process.env.CONVEX_DEPLOY_KEY ||= "test-deploy-key";
  const calls: Array<{ ref: unknown; args: unknown }> = [];
  const client = getConvexClient();
  (client as unknown as { action: unknown }).action = async (
    ref: unknown,
    args: unknown,
  ) => {
    calls.push({ ref, args });
    return true;
  };

  const removed = await convexStorage.crons.remove("acct_1", "cron_1");

  expect(removed).toBe(true);
  expect(calls).toHaveLength(1);
  // The generated API is a proxy, so assert by registered name, not identity.
  expect(getFunctionName(calls[0]?.ref as never)).toBe("awsCrons:remove");
  expect(calls[0]?.args).toMatchObject({
    accountId: "acct_1",
    cronId: "cron_1",
  });
});
