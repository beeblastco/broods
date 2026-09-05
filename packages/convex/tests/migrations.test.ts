/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const AUTH_ID = "auth_owner";

const migrationTest = () => convexTest(schema, modules);

type T = ReturnType<typeof migrationTest>;

async function seedProject(t: T, slug: string): Promise<Id<"projects">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: slug,
      slug: slug,
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: Date.now(),
    });

    return await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: slug,
      slug: slug,
      updatedAt: Date.now(),
    });
  });
}

describe("backfillStageKinds", () => {
  test("promotes a lone kind-less Production to the Development default, like ensureDefault would", async () => {
    const t = migrationTest();
    const projectId = await seedProject(t, "legacy");
    const stageId = await t.run(async (ctx) =>
      ctx.db.insert("stages", {
        authId: AUTH_ID,
        projectId: projectId,
        name: "Production",
        deploymentRegion: "us-east-1",
        isDefault: false,
        updatedAt: 1,
      }),
    );

    const result = await t.mutation(internal.migrations.backfillStageKinds, {});
    const stage = await t.run(async (ctx) => ctx.db.get(stageId));

    expect(result).toMatchObject({ patched: 1, isDone: true });
    expect(stage).toMatchObject({
      name: "Development",
      kind: "development",
      isDefault: true,
    });
    expect(stage?.deploymentRegion).toBeUndefined();
  });

  test("stamps every other kind-less stage by name and leaves stamped rows alone", async () => {
    const t = migrationTest();
    const projectId = await seedProject(t, "mixed");
    const ids = await t.run(async (ctx) => {
      const base = { authId: AUTH_ID, projectId: projectId, updatedAt: 1 };

      return {
        development: await ctx.db.insert("stages", {
          ...base,
          name: "Development",
          kind: "development" as const,
          isDefault: true,
        }),
        production: await ctx.db.insert("stages", {
          ...base,
          name: "Production",
          isDefault: false,
        }),
        staging: await ctx.db.insert("stages", {
          ...base,
          name: " Staging ",
          isDefault: false,
        }),
      };
    });

    const result = await t.mutation(internal.migrations.backfillStageKinds, {});
    const stages = await t.run(async (ctx) => ({
      development: await ctx.db.get(ids.development),
      production: await ctx.db.get(ids.production),
      staging: await ctx.db.get(ids.staging),
    }));

    expect(result).toMatchObject({ patched: 2, isDone: true });
    expect(stages.development).toMatchObject({
      name: "Development",
      kind: "development",
      isDefault: true,
    });
    expect(stages.production).toMatchObject({
      name: "Production",
      kind: "production",
      isDefault: false,
    });
    expect(stages.staging).toMatchObject({
      name: " Staging ",
      kind: "custom",
    });
  });
});
