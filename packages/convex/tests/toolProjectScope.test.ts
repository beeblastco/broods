/// <reference types="vite/client" />
/** Custom tools belong to one stage: they clone, delete and collide like any other node. */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const TOOL_NAME = "system_report";

type Scope = {
  accountId: Id<"accounts">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
};

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

/** An org, account, project and one stage — the scope a tool hangs off. */
async function seedScope(tt: T, stage = "Development"): Promise<Scope> {
  return await tt.run(async (ctx) => {
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
      username: "beeblast-dev",
      secretHash: "hash-tool-scope",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner@example.com",
      orgId: orgId,
      name: "tool-custom-stream",
      slug: "tool-custom-stream",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner@example.com",
      projectId: projectId,
      name: stage,
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });

    return {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}

async function seedTool(
  tt: T,
  scope: Scope,
  name = TOOL_NAME,
): Promise<Id<"accountTools">> {
  return await tt.mutation(internal.account.tools.create, {
    accountId: scope.accountId,
    projectId: scope.projectId,
    stageId: scope.stageId,
    name: name,
    description: "Reports host facts.",
    inputSchema: { type: "object", properties: {} },
    bundleStorageKey: `tools/${name}.mjs`,
    sha256: "a".repeat(64),
    runtime: "sandbox" as const,
  });
}

describe("custom tools are scoped to a stage", () => {
  test("the same tool name in two stages stays two rows", async () => {
    const tt = t();
    const first = await seedScope(tt);
    const second = await tt.run(async (ctx) => {
      const stageId = await ctx.db.insert("stages", {
        authId: "auth_owner@example.com",
        projectId: first.projectId,
        name: "Production",
        kind: "production" as const,
        isDefault: false,
        updatedAt: Date.now(),
      });

      return { ...first, stageId: stageId };
    });

    const firstId = await seedTool(tt, first);
    const secondId = await seedTool(tt, second);

    // Account-scoped matching used to make the second sync overwrite the first.
    expect(firstId).not.toEqual(secondId);
    const listed = await tt.query(internal.account.tools.listForStage, {
      stageId: first.stageId,
    });
    expect(listed.map((row) => row._id)).toEqual([firstId]);
  });

  test("create refuses a project outside the account's org", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const foreignProjectId = await tt.run(
      async (ctx) =>
        await ctx.db.insert("projects", {
          authId: "auth_other@example.com",
          name: "other",
          slug: "other",
          updatedAt: Date.now(),
        }),
    );

    await expect(
      tt.mutation(internal.account.tools.create, {
        accountId: scope.accountId,
        projectId: foreignProjectId,
        stageId: scope.stageId,
        name: TOOL_NAME,
        description: "d",
        inputSchema: {},
        bundleStorageKey: "k",
        sha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/Project not found/);
  });

  test("create refuses a stage from another project", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const sibling = await tt.run(async (ctx) => {
      const account = await ctx.db.get(scope.accountId);
      const projectId = await ctx.db.insert("projects", {
        authId: "auth_owner@example.com",
        orgId: ctx.db.normalizeId("orgs", account!.orgId)!,
        name: "sibling",
        slug: "sibling",
        updatedAt: Date.now(),
      });

      return projectId;
    });

    await expect(
      tt.mutation(internal.account.tools.create, {
        accountId: scope.accountId,
        projectId: sibling,
        stageId: scope.stageId,
        name: TOOL_NAME,
        description: "d",
        inputSchema: {},
        bundleStorageKey: "k",
        sha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/Stage not found/);
  });

  test("resolveScope finds the stage by name, and nothing else", async () => {
    const tt = t();
    const scope = await seedScope(tt);

    expect(
      await tt.query(internal.account.tools.resolveScope, {
        accountId: scope.accountId,
        project: "tool-custom-stream",
        stage: "development",
      }),
    ).toEqual({
      projectId: scope.projectId,
      stageId: scope.stageId,
    });
    expect(
      await tt.query(internal.account.tools.resolveScope, {
        accountId: scope.accountId,
        project: "tool-custom-stream",
        stage: "staging",
      }),
    ).toBeNull();
  });
});

describe("migrations.deleteOrphanedTools", () => {
  test("drops unowned rows and keeps scoped ones", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const keptId = await seedTool(tt, scope);

    await tt.run(async (ctx) => {
      const now = Date.now();
      const base = {
        accountId: scope.accountId,
        description: "d",
        inputSchema: {},
        bundleStorageKey: "k",
        sha256: "c".repeat(64),
        createdAt: now,
        updatedAt: now,
      };
      // Written by the old account-scoped REST API: no stage owns it.
      await ctx.db.insert("accountTools", {
        ...base,
        name: "legacy",
        status: "active" as const,
      });
      await ctx.db.insert("accountTools", {
        ...base,
        projectId: scope.projectId,
        stageId: scope.stageId,
        name: "tombstone",
        status: "deleted" as const,
      });
    });

    const dry = await tt.mutation(internal.migrations.deleteOrphanedTools, {
      dryRun: true,
    });
    expect(dry).toEqual({
      unscoped: 1,
      softDeleted: 1,
      danglingStage: 0,
      kept: 1,
    });
    // A dry run must not touch anything.
    expect(
      await tt.run(async (ctx) => ctx.db.query("accountTools").collect()),
    ).toHaveLength(3);

    await tt.mutation(internal.migrations.deleteOrphanedTools, {});
    const remaining = await tt.run(
      async (ctx) => await ctx.db.query("accountTools").collect(),
    );
    expect(remaining.map((row) => row._id)).toEqual([keptId]);
  });

  test("drops rows whose stage was deleted", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    await seedTool(tt, scope);
    await tt.run(async (ctx) => await ctx.db.delete(scope.stageId));

    expect(
      await tt.mutation(internal.migrations.deleteOrphanedTools, {}),
    ).toEqual({
      unscoped: 0,
      softDeleted: 0,
      danglingStage: 1,
      kept: 0,
    });
  });

  test("drops rows whose stage sits under another project", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const toolId = await seedTool(tt, scope);
    // `create` rejects this pair, so only a hand-edited row can hold it.
    await tt.run(async (ctx) => {
      const account = await ctx.db.get(scope.accountId);
      const strayProjectId = await ctx.db.insert("projects", {
        authId: "auth_owner@example.com",
        orgId: ctx.db.normalizeId("orgs", account!.orgId)!,
        name: "stray",
        slug: "stray",
        updatedAt: Date.now(),
      });
      await ctx.db.patch(toolId, { projectId: strayProjectId });
    });

    expect(
      await tt.mutation(internal.migrations.deleteOrphanedTools, {}),
    ).toEqual({
      unscoped: 0,
      softDeleted: 0,
      danglingStage: 1,
      kept: 0,
    });
  });
});
