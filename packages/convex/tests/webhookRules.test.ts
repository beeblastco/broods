/// <reference types="vite/client" />
/**
 * The dashboard webhook mutations run the config plane's hook rules
 * (model/agentRules.ts): a non-https URL or an unknown lifecycle event is
 * refused on the dashboard path exactly as the config HTTP surface refuses it.
 */

import workosTest from "@convex-dev/workos-authkit/test";
import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import { api, components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const AUTH_ID = "user_webhook_rules_owner";
const modules = import.meta.glob("../**/*.ts");

type T = TestConvex<typeof schema>;

test("addAgentWebhook refuses a non-https URL", async () => {
  const { caller, configId } = await setup();
  await expect(
    caller.mutation(api.webhooks.addAgentWebhook, {
      agentConfigId: configId,
      url: "http://example.invalid/hook",
      secret: "fixture-secret",
    }),
  ).rejects.toThrow(/https/i);
});

test("addAgentWebhook refuses a private host", async () => {
  const { caller, configId } = await setup();
  await expect(
    caller.mutation(api.webhooks.addAgentWebhook, {
      agentConfigId: configId,
      url: "https://10.0.0.8/hook",
      secret: "fixture-secret",
    }),
  ).rejects.toThrow(/private or internal/);
});

test("addAgentWebhook refuses an unknown event name", async () => {
  const { caller, configId } = await setup();
  await expect(
    caller.mutation(api.webhooks.addAgentWebhook, {
      agentConfigId: configId,
      url: "https://example.invalid/hook",
      secret: "fixture-secret",
      events: ["not.an.event"],
    }),
  ).rejects.toThrow(/events must be an array of/);
});

test("addAgentWebhook keeps a valid webhook", async () => {
  const { caller, configId, projectId, stageId } = await setup();
  await caller.mutation(api.webhooks.addAgentWebhook, {
    agentConfigId: configId,
    url: "https://example.invalid/hook",
    secret: "fixture-secret",
    events: ["agent.finished"],
  });
  const listed = await caller.query(api.webhooks.listAgentWebhooks, {
    projectId: projectId,
    stageId: stageId,
  });
  expect(listed).toHaveLength(1);
  expect(listed[0]?.webhooks).toEqual([
    {
      index: 0,
      enabled: true,
      url: "https://example.invalid/hook",
      hasSecret: true,
      events: ["agent.finished"],
    },
  ]);
});

async function setup(): Promise<{
  caller: ReturnType<T["withIdentity"]>;
  configId: Id<"agentConfigs">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
}> {
  const t = convexTest(schema, modules);
  workosTest.register(t);
  await seedAuthUser(t);
  const caller = t.withIdentity({ subject: AUTH_ID });
  const orgId = await caller.mutation(api.org.orgs.create, {
    name: "Webhook rules fixture",
  });
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "fixture",
      slug: "fixture",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("agentConfigs", {
      authId: AUTH_ID,
      projectId: projectId,
      stageId: stageId,
      name: "planner",
      updatedAt: now,
    });

    return { projectId: projectId, stageId: stageId, configId: configId };
  });

  return { caller: caller, ...ids };
}

/** Seed AuthKit's verified user projection without replacing its getAuthUser implementation. */
async function seedAuthUser(t: T): Promise<void> {
  const now = new Date().toISOString();
  await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
    event: {
      id: "evt_webhook_rules_signup",
      event: "user.created",
      createdAt: now,
      data: {
        id: AUTH_ID,
        email: "webhook-rules@example.invalid",
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
      email: "webhook-rules@example.invalid",
      name: "Webhook rules owner",
      plan: "free",
    });
  });
}
