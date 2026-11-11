/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { STAGE_SOURCE_LIMITS } from "../model/stageSource";
import schema from "../schema";
import { deleteStageSources } from "../stageSources";

const modules = import.meta.glob("../**/*.ts");

// The old nightly orphan prune deleted these files, so live rows can point at nothing.
describe("stage source rows whose file is gone", () => {
  test("a stage past the kept revisions still accepts a new one", async () => {
    const { t, stageId } = await seedRevisions(STAGE_SOURCE_LIMITS.revisions);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["{}"])),
    );

    const revision = await t.mutation(internal.stageSources.recordSync, {
      stageId: stageId,
      manifestHash: "m",
      source: {
        hash: "new",
        storageId: storageId,
        fileCount: 1,
        bytes: 2,
        origin: "cli",
      },
    });

    expect(revision).toBe(STAGE_SOURCE_LIMITS.revisions + 1);
    expect(await revisions(t, stageId)).not.toContain(1);
  });

  test("deleting the stage's sources succeeds", async () => {
    const { t, stageId } = await seedRevisions(2);

    await t.run(async (ctx) => deleteStageSources(ctx, stageId));

    expect(await revisions(t, stageId)).toEqual([]);
  });
});

async function revisions(
  t: TestConvex<typeof schema>,
  stageId: Id<"stages">,
): Promise<number[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("stageSources")
      .withIndex("by_stageId_and_revision", (q) => q.eq("stageId", stageId))
      .collect();

    return rows.map((row) => row.revision);
  });
}

// Revision 1's file is deleted from storage, the rest still exist.
async function seedRevisions(
  count: number,
): Promise<{ t: TestConvex<typeof schema>; stageId: Id<"stages"> }> {
  const t = convexTest(schema, modules);
  const stageId = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "o",
      slug: "o",
      ownerAuthId: "owner",
      plan: "free",
      createdAt: 0,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "owner",
      orgId: orgId,
      name: "app",
      slug: "app",
      updatedAt: 0,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "owner",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: 0,
    });
    for (let revision = 1; revision <= count; revision++) {
      const storageId = await ctx.storage.store(new Blob(["{}"]));
      if (revision === 1) await ctx.storage.delete(storageId);
      await ctx.db.insert("stageSources", {
        stageId: stageId,
        revision: revision,
        hash: `h${revision}`,
        storageId: storageId,
        fileCount: 1,
        bytes: 2,
        origin: "cli",
        createdAt: 0,
      });
    }

    return stageId;
  });

  return { t: t, stageId: stageId };
}
