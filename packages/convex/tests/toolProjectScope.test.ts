/// <reference types="vite/client" />
/** Custom tools belong to one environment: they clone, delete and collide like any other node. */

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
  environmentId: Id<"environments">;
};

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

/** An org, account, project and one environment — the scope a tool hangs off. */
async function seedScope(tt: T, environment = "Development"): Promise<Scope> {
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
    const environmentId = await ctx.db.insert("environments", {
      authId: "auth_owner@example.com",
      projectId: projectId,
      name: environment,
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });

    return {
      accountId: accountId,
      projectId: projectId,
      environmentId: environmentId,
    };
  });
}

async function seedTool(
  tt: T,
  scope: Scope,
  name = TOOL_NAME,
): Promise<Id<"accountTools">> {
  return await tt.mutation(internal.accountTools.create, {
    accountId: scope.accountId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    name: name,
    description: "Reports host facts.",
    inputSchema: { type: "object", properties: {} },
    bundleStorageKey: `tools/${name}.mjs`,
    sha256: "a".repeat(64),
    runtime: "sandbox" as const,
  });
}

describe("custom tools are scoped to an environment", () => {
  test("the same tool name in two environments stays two rows", async () => {
    const tt = t();
    const first = await seedScope(tt);
    const second = await tt.run(async (ctx) => {
      const environmentId = await ctx.db.insert("environments", {
        authId: "auth_owner@example.com",
        projectId: first.projectId,
        name: "Production",
        kind: "production" as const,
        isDefault: false,
        updatedAt: Date.now(),
      });

      return { ...first, environmentId: environmentId };
    });

    const firstId = await seedTool(tt, first);
    const secondId = await seedTool(tt, second);

    // Account-scoped matching used to make the second sync overwrite the first.
    expect(firstId).not.toEqual(secondId);
    const listed = await tt.query(internal.accountTools.listForEnvironment, {
      environmentId: first.environmentId,
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
      tt.mutation(internal.accountTools.create, {
        accountId: scope.accountId,
        projectId: foreignProjectId,
        environmentId: scope.environmentId,
        name: TOOL_NAME,
        description: "d",
        inputSchema: {},
        bundleStorageKey: "k",
        sha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/Project not found/);
  });

  test("create refuses an environment from another project", async () => {
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
      tt.mutation(internal.accountTools.create, {
        accountId: scope.accountId,
        projectId: sibling,
        environmentId: scope.environmentId,
        name: TOOL_NAME,
        description: "d",
        inputSchema: {},
        bundleStorageKey: "k",
        sha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/Environment not found/);
  });

  test("resolveScope finds the environment by name, and nothing else", async () => {
    const tt = t();
    const scope = await seedScope(tt);

    expect(
      await tt.query(internal.accountTools.resolveScope, {
        accountId: scope.accountId,
        project: "tool-custom-stream",
        environment: "development",
      }),
    ).toEqual({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    });
    expect(
      await tt.query(internal.accountTools.resolveScope, {
        accountId: scope.accountId,
        project: "tool-custom-stream",
        environment: "staging",
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
      // Written by the old account-scoped REST API: no environment owns it.
      await ctx.db.insert("accountTools", {
        ...base,
        name: "legacy",
        status: "active" as const,
      });
      await ctx.db.insert("accountTools", {
        ...base,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
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
      danglingEnvironment: 0,
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

  test("drops rows whose environment was deleted", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    await seedTool(tt, scope);
    await tt.run(async (ctx) => await ctx.db.delete(scope.environmentId));

    expect(
      await tt.mutation(internal.migrations.deleteOrphanedTools, {}),
    ).toEqual({
      unscoped: 0,
      softDeleted: 0,
      danglingEnvironment: 1,
      kept: 0,
    });
  });

  test("saving a node revives its tombstone and carries the scope", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const nodeId = "node-report";
    const toolId = await tt.mutation(internal.toolService.upsertForNode, {
      accountId: scope.accountId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      nodeId: nodeId,
      name: TOOL_NAME,
      sourceCode: "export default () => 1;",
      sha256: "b".repeat(64),
      bundleStorageKey: `tools/${TOOL_NAME}.mjs`,
    });
    // A row the REST delete tombstoned, left unscoped by the old sync path.
    await tt.run(async (ctx) => {
      await ctx.db.patch(toolId, {
        status: "deleted" as const,
        deletedAt: Date.now(),
        projectId: undefined,
      });
    });

    expect(
      await tt.mutation(internal.toolService.upsertForNode, {
        accountId: scope.accountId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        nodeId: nodeId,
        name: TOOL_NAME,
        sourceCode: "export default () => 2;",
        sha256: "c".repeat(64),
        bundleStorageKey: `tools/${TOOL_NAME}.mjs`,
      }),
    ).toEqual(toolId);

    const row = await tt.run(async (ctx) => await ctx.db.get(toolId));
    expect(row?.status).toEqual("active");
    expect(row?.deletedAt).toBeUndefined();
    expect(row?.projectId).toEqual(scope.projectId);
  });

  test("drops rows whose environment sits under another project", async () => {
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
      danglingEnvironment: 1,
      kept: 0,
    });
  });
});
