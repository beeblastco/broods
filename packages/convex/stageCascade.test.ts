/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { DataModel, Id } from "./_generated/dataModel";
import schema from "./schema";
import { deleteStageContents } from "./stage";

const modules = import.meta.glob("./**/*.ts");

const cascadeTest = () => convexTest(schema, modules);

type T = ReturnType<typeof cascadeTest>;
type StageScopedTable = Extract<
  keyof DataModel,
  | "agentConfigs"
  | "canvasLayouts"
  | "agentDeployments"
  | "deployKeys"
  | "accountTools"
  | "environmentVariables"
  | "environmentVariableReveals"
  | "channelRecords"
  | "agentPolicies"
  | "sandboxConfigs"
  | "workspaceConfigs"
  | "cliExternalResources"
>;

const AUTH_ID = "auth_owner";

// Every table `deleteStageContents` owns. Runtime and audit tables
// (sandboxInstances, sandboxAuditEvents, configAuditEvents) are swept at the
// account level instead and are deliberately absent.
const STAGE_SCOPED_TABLES: StageScopedTable[] = [
  "agentConfigs",
  "canvasLayouts",
  "agentDeployments",
  "deployKeys",
  "accountTools",
  "environmentVariables",
  "environmentVariableReveals",
  "channelRecords",
  "agentPolicies",
  "sandboxConfigs",
  "workspaceConfigs",
  "cliExternalResources",
];

async function seedFullStage(t: T) {
  return await t.run(async (ctx) => {
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
      secretHash: "hash-beeblast",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Production",
      kind: "production" as const,
      isDefault: false,
      updatedAt: now,
    });

    await ctx.db.insert("agentConfigs", {
      authId: AUTH_ID,
      name: "planner",
      projectId: projectId,
      stageId: stageId,
      updatedAt: now,
    });
    await ctx.db.insert("canvasLayouts", {
      authId: AUTH_ID,
      projectId: projectId,
      stageId: stageId,
      nodes: [],
      edges: [],
      updatedAt: now,
    });
    await ctx.db.insert("agentDeployments", {
      authId: AUTH_ID,
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      status: "active" as const,
      endpointId: `stage-${stageId.slice(-8)}`,
      projectSlug: "demo-app",
      stageSlug: "production",
      apiKeyHash: "hash-key",
      keyHint: "bd_…abcd",
      apiKeyCiphertext: "ct",
      apiKeyIv: "iv",
      apiKeyTag: "tag",
      updatedAt: now,
    });
    await ctx.db.insert("deployKeys", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "ci",
      keyHash: "hash-deploy",
      keyHint: "bd_…wxyz",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("accountTools", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "lookup",
      description: "lookup tool",
      inputSchema: {},
      bundleStorageKey: "bundles/lookup.js",
      sha256: "abc",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const environmentVariableId = await ctx.db.insert("environmentVariables", {
      projectId: projectId,
      stageId: stageId,
      name: "DEEPSEEK_API_KEY",
      ciphertext: "ct",
      iv: "iv",
      tag: "tag",
      updatedAt: now,
    });
    await ctx.db.insert("environmentVariableReveals", {
      projectId: projectId,
      stageId: stageId,
      environmentVariableId: environmentVariableId,
      name: "DEEPSEEK_API_KEY",
      source: "dashboard" as const,
      revealedByAuthId: AUTH_ID,
      revealedAt: now,
    });
    await ctx.db.insert("channelRecords", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      platform: "slack",
      externalId: "C_LAMY",
      name: "#lamy",
      config: {},
      status: "active" as const,
      managedBy: "cli" as const,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("agentPolicies", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "guardrails",
      document: {},
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("sandboxConfigs", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "builder",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceConfigs", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "repo",
      config: {},
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("cliExternalResources", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      kind: "skill" as const,
      name: "research",
      externalId: "skill_1",
      config: {},
      updatedAt: now,
    });

    return {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}

async function rowsForStage(
  t: T,
  table: StageScopedTable,
  stageId: Id<"stages">,
) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query(table).collect();

    return rows.filter((row) => row.stageId === stageId);
  });
}

// `deleteStageContents` is the single cascade both `stage.remove` and
// `cascade.purgeProject` call, so a table missing from it orphans rows on
// every deletion path at once.
describe("deleteStageContents", () => {
  test("seeds one row in every stage-scoped table", async () => {
    const t = cascadeTest();
    const { stageId } = await seedFullStage(t);

    for (const table of STAGE_SCOPED_TABLES) {
      expect(
        (await rowsForStage(t, table, stageId)).length,
        `${table} should be seeded`,
      ).toBe(1);
    }
  });

  test("leaves no row carrying the deleted stage id", async () => {
    const t = cascadeTest();
    const { stageId } = await seedFullStage(t);

    await t.run(async (ctx) => {
      const stage = await ctx.db.get(stageId);
      await deleteStageContents(ctx, stage!);
    });

    const orphaned: string[] = [];
    for (const table of STAGE_SCOPED_TABLES) {
      const rows = await rowsForStage(t, table, stageId);
      if (rows.length > 0) orphaned.push(`${table} (${rows.length})`);
    }

    expect(orphaned).toEqual([]);
  });

  // The webhook lookup ignores stageId, so an orphaned record both routes
  // inbound messages into the dead stage and permanently squats the
  // (accountId, platform, externalId) slot that `create` guards.
  test("frees the channel place so it can be rebound after deletion", async () => {
    const t = cascadeTest();
    const { accountId, stageId } = await seedFullStage(t);

    await t.run(async (ctx) => {
      const stage = await ctx.db.get(stageId);
      await deleteStageContents(ctx, stage!);
    });

    const stillRouting = await t.run(async (ctx) =>
      ctx.db
        .query("channelRecords")
        .withIndex("by_accountId_platform_external", (q) =>
          q
            .eq("accountId", accountId)
            .eq("platform", "slack")
            .eq("externalId", "C_LAMY")
            .eq("status", "active"),
        )
        .first(),
    );

    expect(stillRouting).toBeNull();
  });
});
