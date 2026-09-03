/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const stageTest = () => convexTest(schema, modules);

type T = ReturnType<typeof stageTest>;

const AUTH_ID = "auth_owner";

async function seedProject(t: T, projectName = "demo-app") {
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
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: projectName,
      slug: projectName,
      updatedAt: Date.now(),
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: Date.now(),
    });
    for (const name of ["DEEPSEEK_API_KEY", "ZALO_BOT_TOKEN"]) {
      await ctx.db.insert("environmentVariables", {
        projectId: projectId,
        stageId: stageId,
        name: name,
        ciphertext: `ct-${name}`,
        iv: `iv-${name}`,
        tag: `tag-${name}`,
        updatedAt: Date.now(),
      });
    }

    return {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}

const list = (t: T, accountId: Id<"accounts">, project: string) =>
  t.query(internal.cli.stages.listByAccount, {
    accountId: accountId,
    project: project,
  });

const create = (
  t: T,
  accountId: Id<"accounts">,
  args: { project: string; name: string; duplicateFrom?: string },
) =>
  t.mutation(internal.cli.stages.createByAccount, {
    accountId: accountId,
    ...args,
  });

describe("listByAccount", () => {
  test("summarizes each stage with its agent and variable counts", async () => {
    const t = stageTest();
    const { accountId } = await seedProject(t);

    const stages = await list(t, accountId, "demo-app");

    expect(stages).toHaveLength(1);
    expect(stages?.[0]).toMatchObject({
      name: "Development",
      kind: "development",
      isDefault: true,
      agentCount: 0,
      variableCount: 2,
    });
  });

  test("returns null when the project is not in the account's org", async () => {
    const t = stageTest();
    const { accountId } = await seedProject(t);

    expect(await list(t, accountId, "other-project")).toBeNull();
  });
});

describe("createByAccount", () => {
  test("clones the source stage's environment variables", async () => {
    const t = stageTest();
    const { accountId, projectId } = await seedProject(t);

    const created = await create(t, accountId, {
      project: "demo-app",
      name: "staging",
      duplicateFrom: "development",
    });

    expect(created?.clonedFrom).toBe("Development");
    expect(created?.stage).toMatchObject({
      name: "staging",
      kind: "custom",
      isDefault: false,
      variableCount: 2,
    });

    // The clone must copy the ciphertext verbatim: the AES-GCM key is derived
    // from the shared secret alone, so re-encryption would be pointless churn.
    const cloned = await t.run(async (ctx) =>
      ctx.db
        .query("environmentVariables")
        .withIndex("by_projectId_and_stageId", (q) =>
          q
            .eq("projectId", projectId)
            .eq("stageId", created!.stage.id as Id<"stages">),
        )
        .collect(),
    );
    expect(cloned.map((entry) => entry.name).sort()).toEqual([
      "DEEPSEEK_API_KEY",
      "ZALO_BOT_TOKEN",
    ]);
    expect(cloned[0]?.ciphertext).toBe("ct-DEEPSEEK_API_KEY");
  });

  test("creates an empty stage when no source is given", async () => {
    const t = stageTest();
    const { accountId } = await seedProject(t);

    const created = await create(t, accountId, {
      project: "demo-app",
      name: "staging",
    });

    expect(created?.clonedFrom).toBeNull();
    expect(created?.stage.variableCount).toBe(0);
  });

  test("canonicalizes the reserved production name and kind", async () => {
    const t = stageTest();
    const { accountId } = await seedProject(t);

    const created = await create(t, accountId, {
      project: "demo-app",
      name: "production",
    });

    expect(created?.stage).toMatchObject({
      name: "Production",
      kind: "production",
      isDefault: false,
    });
  });

  test("rejects a name that already exists, case-insensitively", async () => {
    const t = stageTest();
    const { accountId } = await seedProject(t);

    await expect(
      create(t, accountId, { project: "demo-app", name: "DEVELOPMENT" }),
    ).rejects.toThrow(/already exists/);
  });

  test("rejects an unknown clone source", async () => {
    const t = stageTest();
    const { accountId } = await seedProject(t);

    await expect(
      create(t, accountId, {
        project: "demo-app",
        name: "staging",
        duplicateFrom: "nope",
      }),
    ).rejects.toThrow(/was not found/);
  });
});

describe("stage names are slugs", () => {
  test("rejects a custom name that would not survive a URL", async () => {
    const t = stageTest();
    const { accountId } = await seedProject(t);

    await expect(
      create(t, accountId, { project: "demo-app", name: "My Stage / v2" }),
    ).rejects.toThrow(
      /lowercase letters, digits and dashes \(try "my-stage-v2"\)/,
    );
    await expect(
      create(t, accountId, { project: "demo-app", name: "-staging" }),
    ).rejects.toThrow(/lowercase letters/);
  });

  test("accepts a slug and still canonicalizes the reserved names", async () => {
    const t = stageTest();
    const { accountId } = await seedProject(t);

    const created = await create(t, accountId, {
      project: "demo-app",
      name: "qa-2",
    });
    expect(created?.stage.name).toBe("qa-2");
    const production = await create(t, accountId, {
      project: "demo-app",
      name: "PRODUCTION",
    });
    expect(production?.stage.name).toBe("Production");
  });
});
