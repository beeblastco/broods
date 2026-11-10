/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const AUTH_ID = "auth_owner@example.com";

test("scopes names the project and stage of each agent that has a config row", async () => {
  const tt = convexTest(schema, modules);
  const { staged, loose } = await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "acme",
      slug: "acme",
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "acme",
      secretHash: "hash-agent-scopes",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "shop",
      slug: "shop",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "production",
      kind: "production" as const,
      isDefault: true,
      updatedAt: now,
    });
    const agent = { accountId: accountId, createdAt: now, updatedAt: now };
    const stagedId = await ctx.db.insert("agents", {
      ...agent,
      name: "support",
    });
    await ctx.db.insert("agentConfigs", {
      authId: AUTH_ID,
      name: "support",
      agentId: stagedId,
      projectId: projectId,
      stageId: stageId,
      updatedAt: now,
    });

    return {
      staged: stagedId,
      loose: await ctx.db.insert("agents", { ...agent, name: "api-made" }),
    };
  });

  expect(
    await tt.query(internal.agent.agents.scopes, { agentIds: [staged, loose] }),
  ).toEqual([{ agentId: staged, project: "shop", stage: "production" }]);
});
