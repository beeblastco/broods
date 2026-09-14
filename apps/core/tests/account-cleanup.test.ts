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
    // Cleanup lists agents to release their derived sandbox reservations too.
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

// agent/crons.remove is the mutation that drops the registered schedule and
// the row in one transaction; assert it is registered at the expected path.
it("registers agent/crons.remove as an internal mutation", () => {
  // agent/crons reaches ../auth, which constructs AuthKit and validates these
  // at import time. Dummy values only, nothing here authenticates.
  process.env.WORKOS_CLIENT_ID ||= "client_test";
  process.env.WORKOS_API_KEY ||= "sk_test";
  process.env.WORKOS_WEBHOOK_SECRET ||= "whsec_test";
  const registered = require("@broods/convex/agent/crons") as Record<
    string,
    { isInternal?: boolean; isMutation?: boolean } | undefined
  >;
  const internal = require("@broods/convex/_generated/api").internal;

  expect(registered.remove).toMatchObject({
    isInternal: true,
    isMutation: true,
  });
  expect(getFunctionName(internal.agent.crons.remove)).toBe(
    "agent/crons:remove",
  );
});

// A reserved extra sandbox is a machine per agent and record, so cleanup has to
// ask about every id the agent attaches, not only config.sandbox.
it("collects reservation keys from an agent's default and extra sandboxes", async () => {
  const requested: string[] = [];
  setStorageForTests({
    workspaceConfigs: {
      list: async function () {
        return [];
      },
      removeAllForAccount: async function () {
        return 0;
      },
    },
    agents: {
      list: async function () {
        return [
          {
            agentId: "ag_1",
            config: { sandbox: "sb_default", sandboxes: ["sb_browser"] },
          },
        ];
      },
    },
    sandboxConfigs: {
      getById: async function (_accountId: string, sandboxId: string) {
        requested.push(sandboxId);

        return {
          sandboxId: sandboxId,
          name: sandboxId,
          config: { provider: "lambda" },
        };
      },
      removeAllForAccount: async function () {
        return 0;
      },
    },
  } as never);
  runtime.mutate = (async () => ({
    conversationsDeleted: 0,
    processedEventsDeleted: 0,
    asyncAgentResultDeleted: 0,
    asyncToolResultDeleted: 0,
    asyncToolGroupDeleted: 0,
    sandboxReservationDeleted: 0,
    totalDeleted: 0,
  })) as never;

  await deleteAccountRuntimeData({
    accountId: "acct_test",
    username: "test",
    secretHash: "hash",
    status: "disabled",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  });

  expect(requested.sort()).toEqual(["sb_browser", "sb_default"]);
});

// The adapter reaches this reference through an any-typed require, so nothing
// but this check catches a rewire that stops descheduling deleted crons.
it("crons.remove delegates to internal.agent.crons.remove via mutation", async () => {
  process.env.CONVEX_URL ||= "https://example.convex.cloud";
  process.env.CONVEX_DEPLOY_KEY ||= "test-deploy-key";
  const calls: Array<{ ref: unknown; args: unknown }> = [];
  const client = getConvexClient();
  (client as unknown as { mutation: unknown }).mutation = async (
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
  expect(getFunctionName(calls[0]?.ref as never)).toBe("agent/crons:remove");
  expect(calls[0]?.args).toMatchObject({
    accountId: "acct_1",
    cronId: "cron_1",
  });
});
