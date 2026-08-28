/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const AUTH_ID = "auth_owner";

type T = TestConvex<typeof schema>;

function projectTest(): T {
  return convexTest(schema, modules);
}

async function seedOrg(t: T): Promise<{
  accountId: Id<"accounts">;
  orgId: Id<"orgs">;
}> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: Date.now(),
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash-beeblast",
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { accountId: accountId, orgId: orgId };
  });
}

/** An org member with the given role, visible to `getProjectForRole`. */
async function seedMember(
  t: T,
  orgId: Id<"orgs">,
  authId: string,
  role: "owner" | "admin" | "member",
): Promise<void> {
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      authId: authId,
      email: `${authId}@example.com`,
      name: authId,
      plan: "free" as const,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: role,
      createdAt: Date.now(),
    });
  });
}

/** A project with one stage, one agent config and one env var. The slug is kept distinct from the name. */
async function seedProject(
  t: T,
  orgId: Id<"orgs">,
  name: string,
  authId: string = AUTH_ID,
): Promise<Id<"projects">> {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      authId: authId,
      orgId: orgId,
      name: name,
      slug: `${name}-slug`,
      updatedAt: Date.now(),
    });
    const stageId = await ctx.db.insert("stages", {
      authId: authId,
      projectId: projectId,
      name: "Development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("agentConfigs", {
      authId: authId,
      name: `${name}-agent`,
      projectId: projectId,
      stageId: stageId,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("environmentVariables", {
      projectId: projectId,
      stageId: stageId,
      name: "DEEPSEEK_API_KEY",
      ciphertext: "ct",
      iv: "iv",
      tag: "tag",
      updatedAt: Date.now(),
    });

    return projectId;
  });
}

/** A project row with no stage under it, which is what cleanup targets. */
async function seedEmptyProject(
  t: T,
  orgId: Id<"orgs">,
  name: string,
): Promise<Id<"projects">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: name,
      slug: `${name}-slug`,
      updatedAt: Date.now(),
    });
  });
}

describe("cliProjects.listByAccount", () => {
  test("reports what each project holds and sorts empty ones last", async () => {
    const t = projectTest();
    const { accountId, orgId } = await seedOrg(t);
    await seedProject(t, orgId, "tracy");
    await seedEmptyProject(t, orgId, "abandoned-e2e");

    const projects = await t.query(internal.cli.projects.listByAccount, {
      accountId: accountId,
    });

    expect(projects?.map((project) => project.name)).toEqual([
      "tracy",
      "abandoned-e2e",
    ]);
    expect(projects?.[0]).toMatchObject({
      empty: false,
      stageCount: 1,
      agentCount: 1,
      variableCount: 1,
      deploymentCount: 0,
      fileCount: 0,
    });
    expect(projects?.[1]).toMatchObject({
      empty: true,
      stageCount: 0,
      agentCount: 0,
    });
  });

  test("a project holding only workspace files is not empty", async () => {
    const t = projectTest();
    const { accountId, orgId } = await seedOrg(t);
    const projectId = await seedEmptyProject(t, orgId, "files-only");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceFiles", {
        authId: AUTH_ID,
        projectId: projectId,
        nodeId: "node-1",
        path: "notes.md",
        name: "notes.md",
        isFolder: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const projects = await t.query(internal.cli.projects.listByAccount, {
      accountId: accountId,
    });

    expect(projects?.[0]).toMatchObject({
      name: "files-only",
      empty: false,
      fileCount: 1,
    });
  });

  test("returns null for a disabled account", async () => {
    const t = projectTest();
    const { accountId } = await seedOrg(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(accountId, { status: "disabled" as const });
    });

    expect(
      await t.query(internal.cli.projects.listByAccount, {
        accountId: accountId,
      }),
    ).toBeNull();
  });
});

describe("cliProjects.removeByAccount", () => {
  test("purges the project's stages and contents, and nothing else", async () => {
    const t = projectTest();
    const { accountId, orgId } = await seedOrg(t);
    const doomed = await seedProject(t, orgId, "abandoned-e2e");
    const keeper = await seedProject(t, orgId, "tracy");

    const deleted = await t.mutation(internal.cli.projects.removeByAccount, {
      accountId: accountId,
      authId: AUTH_ID,
      projectId: doomed,
    });

    expect(deleted).toMatchObject({
      name: "abandoned-e2e",
      stageCount: 1,
      agentCount: 1,
      variableCount: 1,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(doomed)).toBeNull();
      expect(
        await ctx.db
          .query("stages")
          .withIndex("by_projectId", (q) => q.eq("projectId", doomed))
          .collect(),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("agentConfigs")
          .withIndex("by_projectId_and_stageId", (q) =>
            q.eq("projectId", doomed),
          )
          .collect(),
      ).toHaveLength(0);
      expect(await ctx.db.get(keeper)).not.toBeNull();
      expect(
        await ctx.db
          .query("environmentVariables")
          .withIndex("by_projectId_and_stageId", (q) =>
            q.eq("projectId", keeper),
          )
          .collect(),
      ).toHaveLength(1);
    });
  });

  test("answers forbidden for a caller without an admin role", async () => {
    const t = projectTest();
    const { accountId, orgId } = await seedOrg(t);
    const target = await seedProject(t, orgId, "tracy", "auth_creator");
    await seedMember(t, orgId, "auth_demoted", "member");

    expect(
      await t.mutation(internal.cli.projects.removeByAccount, {
        accountId: accountId,
        authId: "auth_demoted",
        projectId: target,
      }),
    ).toBe("forbidden");
    await t.run(async (ctx) => {
      expect(await ctx.db.get(target)).not.toBeNull();
    });
  });

  test("lets a non-creator org admin delete", async () => {
    const t = projectTest();
    const { accountId, orgId } = await seedOrg(t);
    const target = await seedProject(t, orgId, "tracy", "auth_creator");
    await seedMember(t, orgId, "auth_admin", "admin");

    const deleted = await t.mutation(internal.cli.projects.removeByAccount, {
      accountId: accountId,
      authId: "auth_admin",
      projectId: target,
    });

    expect(deleted).toMatchObject({ name: "tracy" });
  });

  test("returns null for an unknown project instead of deleting anything", async () => {
    const t = projectTest();
    const { accountId, orgId } = await seedOrg(t);
    const keeper = await seedProject(t, orgId, "tracy");

    expect(
      await t.mutation(internal.cli.projects.removeByAccount, {
        accountId: accountId,
        authId: AUTH_ID,
        projectId: "never-existed",
      }),
    ).toBeNull();
    await t.run(async (ctx) => {
      expect(await ctx.db.get(keeper)).not.toBeNull();
    });
  });

  test("refuses to reach into another org's project", async () => {
    const t = projectTest();
    const { accountId } = await seedOrg(t);
    const otherOrg = await t.run(async (ctx) => {
      return await ctx.db.insert("orgs", {
        name: "other",
        slug: "other",
        ownerAuthId: "auth_other",
        plan: "free" as const,
        createdAt: Date.now(),
      });
    });
    const foreign = await seedProject(t, otherOrg, "not-yours", "auth_other");

    expect(
      await t.mutation(internal.cli.projects.removeByAccount, {
        accountId: accountId,
        authId: AUTH_ID,
        projectId: foreign,
      }),
    ).toBeNull();
    await t.run(async (ctx) => {
      expect(await ctx.db.get(foreign)).not.toBeNull();
    });
  });
});
