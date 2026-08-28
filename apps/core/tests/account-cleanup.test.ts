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
      list: async function () {
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
      list: async function () {
        return [];
      },
      removeAllForAccount: async function () {
        return 0;
      },
    },
    // Agents are listed too: an agent's own sandbox reserves on a derived key, not
    // on a workspace namespace, so cleanup has to release both kinds.
    agents: {
      list: async function () {
        return [];
      },
    },
    sandboxConfigs: {
      removeAllForAccount: async function () {
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

// aws/crons.remove is the action that deletes the EventBridge schedule and the
// row together; assert it is a registered internal action at the expected path.
it("registers aws/crons.remove as an internal action", () => {
  const registered = require("@broods/convex/aws/crons") as Record<
    string,
    { isInternal?: boolean; isAction?: boolean } | undefined
  >;
  const internal = require("@broods/convex/_generated/api").internal;

  expect(registered.remove).toMatchObject({ isInternal: true, isAction: true });
  expect(getFunctionName(internal.aws.crons.remove)).toBe("aws/crons:remove");
});

// The adapter reaches this reference through an any-typed require, so nothing but
// this check catches a rewire that stops deleting EventBridge schedules.
it("crons.remove delegates to internal.aws.crons.remove via action", async () => {
  process.env.CONVEX_URL ||= "https://example.convex.cloud";
  process.env.CONVEX_DEPLOY_KEY ||= "test-deploy-key";
  const calls: Array<{ ref: unknown; args: unknown }> = [];
  const client = getConvexClient();
  (client as unknown as { action: unknown }).action = async (
    ref: unknown,
    args: unknown,
  ) => {
    calls.push({ ref: ref, args: args });

    return true;
  };

  const removed = await convexStorage.crons.remove("acct_1", "cron_1");

  expect(removed).toBe(true);
  expect(calls).toHaveLength(1);
  // The generated API is a proxy, so assert by registered name, not identity.
  expect(getFunctionName(calls[0]?.ref as never)).toBe("aws/crons:remove");
  expect(calls[0]?.args).toMatchObject({
    accountId: "acct_1",
    cronId: "cron_1",
  });
});
