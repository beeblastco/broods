/// <reference types="vite/client" />

import cronsComponent from "@convex-dev/crons/test";
import workosTest from "@convex-dev/workos-authkit/test";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, components, internal } from "../_generated/api";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const AUTH_ID = "user_cron_clear_owner";
const modules = import.meta.glob("../**/*.ts");

test("the dashboard clears a cron's description and conversation key with null", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  workosTest.register(t);
  cronsComponent.register(t);
  await seedAuthUser(t);
  const caller = t.withIdentity({ subject: AUTH_ID });
  const orgId = await caller.mutation(api.org.orgs.create, {
    name: "Cron clear fixture",
  });
  const account = await t.mutation(internal.account.accounts.create, {
    orgId: orgId,
    username: "cron-clear-fixture",
    secretHash: await sha256Hex("bask_cron_clear_fixture_key"),
  });
  const agentId = await t.run(async (ctx) =>
    ctx.db.insert("agents", {
      accountId: account._id,
      name: "fixture-agent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const { cronId } = await caller.mutation(api.agent.cronsPublic.create, {
    name: "nightly",
    agentId: agentId,
    input: "run",
    conversationKey: "nightly-thread",
    scheduleExpression: "rate(1 day)",
    status: "active",
    description: "Nightly report",
  });

  await caller.mutation(api.agent.cronsPublic.update, {
    cronId: cronId,
    conversationKey: null,
    description: null,
  });

  const cron = await t.run(async (ctx) =>
    ctx.db
      .query("crons")
      .filter((q) => q.eq(q.field("name"), "nightly"))
      .unique(),
  );
  expect(cron?.description).toBeUndefined();
  expect(cron?.conversationKey).toBeUndefined();
});

async function seedAuthUser(t: ReturnType<typeof convexTest>): Promise<void> {
  const now = new Date().toISOString();
  await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
    event: {
      id: "evt_cron_clear_signup",
      event: "user.created",
      createdAt: now,
      data: {
        id: AUTH_ID,
        email: "cron-clear@example.invalid",
        emailVerified: true,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await t.run(async (ctx): Promise<void> => {
    await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "cron-clear@example.invalid",
      name: "Cron clear owner",
      plan: "free",
    });
  });
}
