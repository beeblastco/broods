/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

type T = TestConvex<typeof schema>;

interface Seeded {
  accountId: Id<"accounts">;
  agentIds: Record<string, Id<"agents">>;
}

describe("agents.listForProduction", (): void => {
  test("lists only the agents of a deployed production stage", async (): Promise<void> => {
    const tt = convexTest(schema, modules);
    const { accountId, agentIds } = await seed(tt, [
      { kind: "production", agent: "prod-bot", deployment: "active" },
      { kind: "development", agent: "dev-bot", deployment: "active" },
    ]);

    const agents = await tt.query(internal.agent.agents.listForProduction, {
      accountId: accountId,
    });

    // The dev agent holds a stage URL of its own; the bare URL never reaches it.
    expect(agents.map((agent): Id<"agents"> => agent._id)).toEqual([
      agentIds["prod-bot"],
    ]);
  });

  test("drops a production stage whose deployment is revoked", async (): Promise<void> => {
    const tt = convexTest(schema, modules);
    const { accountId } = await seed(tt, [
      { kind: "production", agent: "prod-bot", deployment: "revoked" },
    ]);

    const agents = await tt.query(internal.agent.agents.listForProduction, {
      accountId: accountId,
    });

    expect(agents).toEqual([]);
  });
});

/** One account with a project, and an agent in each named stage. */
async function seed(
  tt: T,
  stages: {
    kind: "development" | "production";
    agent: string;
    deployment: "active" | "revoked" | null;
  }[],
): Promise<Seeded> {
  return await tt.run(async (ctx): Promise<Seeded> => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner@example.com",
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash-production-agents",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner@example.com",
      orgId: orgId,
      name: "tracy",
      slug: "tracy",
      updatedAt: now,
    });
    const agentIds: Record<string, Id<"agents">> = {};
    for (const [index, entry] of stages.entries()) {
      const stageId = await ctx.db.insert("stages", {
        authId: "auth_owner@example.com",
        projectId: projectId,
        name: entry.kind,
        kind: entry.kind,
        isDefault: entry.kind === "development",
        updatedAt: now,
      });
      const agentId = await ctx.db.insert("agents", {
        accountId: accountId,
        name: entry.agent,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("agentConfigs", {
        authId: "auth_owner@example.com",
        name: entry.agent,
        agentId: agentId,
        projectId: projectId,
        stageId: stageId,
        updatedAt: now,
      });
      if (entry.deployment) {
        await ctx.db.insert("agentDeployments", {
          authId: "auth_owner@example.com",
          accountId: accountId,
          projectId: projectId,
          stageId: stageId,
          status: entry.deployment,
          endpointId: `ep_${index}`,
          projectSlug: "tracy",
          stageSlug: entry.kind,
          apiKeyHash: `hash-${index}`,
          keyHint: "fp_agent_…abcd",
          apiKeyCiphertext: "ct",
          apiKeyIv: "iv",
          apiKeyTag: "tag",
          updatedAt: now,
        });
      }
      agentIds[entry.agent] = agentId;
    }

    return { accountId: accountId, agentIds: agentIds };
  });
}
