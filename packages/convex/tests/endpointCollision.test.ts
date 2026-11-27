/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

// Two stages whose ids end in the same 8 characters get the same endpoint id.
const SHARED_ENDPOINT_ID = "stage-abcdefgh";

type T = TestConvex<typeof schema>;

interface Tenant {
  accountId: Id<"accounts">;
  agentId: Id<"agents">;
}

test("an account reads only its own usage on an endpoint id another account shares", async (): Promise<void> => {
  const tt = convexTest(schema, modules);
  const first = await seedTenant(tt, "first");
  const second = await seedTenant(tt, "second");
  await tt.run(async (ctx) => {
    await ctx.db.insert("usageRollups", {
      accountId: first.accountId,
      endpointId: SHARED_ENDPOINT_ID,
      bucketStart: Date.now() - 60_000,
      grain: "5m",
      modelProvider: "anthropic",
      modelId: "claude-test",
      inputTokens: 1000,
      outputTokens: 10,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1010,
      invocations: 1,
      modelCalls: 1,
      runtimeWallMs: 100,
      agentSandboxCpuUsec: 0,
      toolSandboxCpuUsec: 0,
      updatedAt: Date.now(),
    });
  });

  const usage = await tt.query(internal.logs.usageForAccountStage, {
    accountId: second.accountId,
    project: "support",
    stage: "development",
    range: "1h",
  });
  const agents = await tt.query(internal.agent.agents.listForEndpoint, {
    accountId: second.accountId,
    endpointId: SHARED_ENDPOINT_ID,
  });

  expect(usage?.totals.inputTokens).toBe(0);
  expect(agents.map((agent) => agent._id)).toEqual([second.agentId]);
});

async function seedTenant(tt: T, name: string): Promise<Tenant> {
  return await tt.run(async (ctx): Promise<Tenant> => {
    const now = Date.now();
    const authId = `auth_${name}@example.com`;
    const orgId = await ctx.db.insert("orgs", {
      name: name,
      slug: name,
      ownerAuthId: authId,
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: name,
      secretHash: `hash-${name}`,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: authId,
      orgId: orgId,
      name: "support",
      slug: "support",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: authId,
      projectId: projectId,
      name: "development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });
    const agentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "bot",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("agentConfigs", {
      authId: authId,
      name: "bot",
      agentId: agentId,
      projectId: projectId,
      stageId: stageId,
      updatedAt: now,
    });
    await ctx.db.insert("agentDeployments", {
      authId: authId,
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      status: "active",
      endpointId: SHARED_ENDPOINT_ID,
      projectSlug: "support",
      stageSlug: "development",
      apiKeyHash: `key-${name}`,
      keyHint: "bsk_…abcd",
      apiKeyCiphertext: "ct",
      apiKeyIv: "iv",
      apiKeyTag: "tag",
      updatedAt: now,
    });

    return { accountId: accountId, agentId: agentId };
  });
}
