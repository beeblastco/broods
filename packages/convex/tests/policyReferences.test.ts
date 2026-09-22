/// <reference types="vite/client" />
/** Deleting a policy an agent or a channel record still lists must refuse. */

import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "fp_acct_test-owner-secret";
const AUTH_ID = "auth_owner";

/** Where the policy and the agent that lists it sit relative to each other. */
interface SeedOptions {
  policyHasStage: boolean;
  agentInPolicyStage: boolean;
}

const SAME_STAGE: SeedOptions = {
  policyHasStage: true,
  agentInPolicyStage: true,
};

const t = (): TestConvex<typeof schema> => convexTest(schema, modules);
type T = ReturnType<typeof t>;

async function seed(
  tt: T,
  options: SeedOptions,
): Promise<{
  accountId: Id<"accounts">;
  policyId: Id<"agentPolicies">;
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
      secretHash: await sha256Hex(ACCOUNT_SECRET),
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
    const otherStageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "prod",
      kind: "production" as const,
      isDefault: false,
      updatedAt: now,
    });
    const policyId = await ctx.db.insert("agentPolicies", {
      accountId: accountId,
      ...(options.policyHasStage
        ? { projectId: projectId, stageId: stageId }
        : {}),
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
      stageId: options.agentInPolicyStage ? stageId : otherStageId,
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

    return { accountId: accountId, policyId: policyId };
  });
}

test("refuses to delete a policy an agent and a channel record still list", async () => {
  const tt = t();
  const { accountId, policyId } = await seed(tt, SAME_STAGE);

  await expect(
    tt.mutation(internal.agent.policies.removeInternal, {
      accountId: accountId,
      policyId: policyId,
    }),
  ).rejects.toThrow(
    'Policy still referenced: agent "planner", channel record "#support" list "guardrails"',
  );
  const policy = await tt.run(async (ctx) => await ctx.db.get(policyId));
  expect(policy?.status).toBe("active");
});

// POST /v1/policies writes a policy with no project or stage.
test("refuses a policy without a stage that an agent lists", async () => {
  const tt = t();
  const { accountId, policyId } = await seed(tt, {
    policyHasStage: false,
    agentInPolicyStage: false,
  });

  await expect(
    tt.mutation(internal.agent.policies.removeInternal, {
      accountId: accountId,
      policyId: policyId,
    }),
  ).rejects.toThrow('agent "planner"');
});

test("refuses a policy that an agent in another stage lists", async () => {
  const tt = t();
  const { accountId, policyId } = await seed(tt, {
    policyHasStage: true,
    agentInPolicyStage: false,
  });

  await expect(
    tt.mutation(internal.agent.policies.removeInternal, {
      accountId: accountId,
      policyId: policyId,
    }),
  ).rejects.toThrow('agent "planner"');
});

test("DELETE /v1/policies/{id} answers 409 while the policy is listed", async () => {
  const tt = t();
  const { policyId } = await seed(tt, SAME_STAGE);

  const response = await tt.fetch(`/v1/policies/${policyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
  });

  expect(response.status).toBe(409);
  const body = (await response.json()) as { error: { message: string } };
  expect(body.error.message).toContain('agent "planner"');
});

test("deletes once nothing lists the policy", async () => {
  const tt = t();
  const { accountId, policyId } = await seed(tt, SAME_STAGE);
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
