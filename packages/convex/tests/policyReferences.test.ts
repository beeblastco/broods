/// <reference types="vite/client" />
/** Deleting a policy an agent or a channel record still lists must refuse. */

import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const AUTH_ID = "auth_owner";

const t = (): TestConvex<typeof schema> => convexTest(schema, modules);
type T = ReturnType<typeof t>;

async function seed(tt: T): Promise<{
  accountId: Id<"accounts">;
  policyId: Id<"agentPolicies">;
  stageId: Id<"stages">;
}> {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "dev",
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });
    const policyId = await ctx.db.insert("agentPolicies", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "guardrails",
      document: { version: 1, mode: "enforce", rules: [] },
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("agentConfigs", {
      authId: AUTH_ID,
      name: "planner",
      projectId: projectId,
      stageId: stageId,
      extraConfig: { policies: [policyId] },
      updatedAt: now,
    });
    await ctx.db.insert("channelRecords", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      platform: "slack",
      externalId: "C001",
      name: "#support",
      config: { agentBindings: [], policies: [policyId] },
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });

    return { accountId: accountId, policyId: policyId, stageId: stageId };
  });
}

test("refuses to delete a policy an agent and a channel record still list", async () => {
  const tt = t();
  const { accountId, policyId } = await seed(tt);

  await expect(
    tt.mutation(internal.agent.policies.removeInternal, {
      accountId: accountId,
      policyId: policyId,
    }),
  ).rejects.toThrow(
    'still referenced by agent "planner", channel record "#support"',
  );
  const policy = await tt.run(async (ctx) => await ctx.db.get(policyId));
  expect(policy?.status).toBe("active");
});

test("deletes once nothing lists the policy", async () => {
  const tt = t();
  const { accountId, policyId } = await seed(tt);
  await tt.run(async (ctx) => {
    for (const agent of await ctx.db.query("agentConfigs").collect()) {
      await ctx.db.patch(agent._id, { extraConfig: {} });
    }
    for (const record of await ctx.db.query("channelRecords").collect()) {
      await ctx.db.patch(record._id, { config: { agentBindings: [] } });
    }
  });

  await tt.mutation(internal.agent.policies.removeInternal, {
    accountId: accountId,
    policyId: policyId,
  });
  const policy = await tt.run(async (ctx) => await ctx.db.get(policyId));
  expect(policy?.status).toBe("deleted");
});
