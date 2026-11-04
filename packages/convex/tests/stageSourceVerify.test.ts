/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const SHA = "a".repeat(40);

async function seed(
  stageHash: string,
  syncedAt: number,
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
      repo: {
        installationId: 1,
        repoId: 7,
        fullName: "acme/app",
        rootDirectory: "",
        developmentBranch: "dev",
        deployKeyIds: [],
        protectedSecrets: true,
      },
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
    await ctx.db.insert("stageSyncs", {
      stageId: stageId,
      revision: 2,
      manifestHash: stageHash,
      syncedAt: syncedAt,
    });
    await ctx.db.insert("stageSources", {
      stageId: stageId,
      revision: 1,
      hash: "h",
      storageId: await ctx.storage.store(new Blob(["{}"])),
      fileCount: 1,
      bytes: 2,
      manifestHash: "applied",
      origin: "apply",
      commitSha: SHA,
      verification: { phase: "verifying" },
      createdAt: 0,
    });

    return stageId;
  });

  return { t: t, stageId: stageId };
}

async function settle(
  stageHash: string,
  conclusion: string,
  ciStoredRow = false,
): Promise<unknown> {
  const { t, stageId } = await seed(stageHash, 200);
  if (ciStoredRow)
    await t.run(async (ctx) => {
      await ctx.db.insert("stageSources", {
        stageId: stageId,
        revision: 2,
        hash: "ci",
        storageId: await ctx.storage.store(new Blob(["{}"])),
        fileCount: 1,
        bytes: 2,
        manifestHash: stageHash,
        origin: "cli",
        commitSha: SHA,
        createdAt: 1,
      });
    });
  await t.mutation(internal.stageSources.verifyRun, {
    repoId: 7,
    branch: "dev",
    sha: SHA,
    conclusion: conclusion,
    url: "https://github.com/acme/app/actions/runs/1",
    startedAt: 100,
  });

  return await t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("stageSources")
          .withIndex("by_stageId_and_revision", (q) => q.eq("stageId", stageId))
          .order("desc")
          .first()
      )?.verification,
  );
}

describe("verifying an Apply on CI", () => {
  test("done only when CI succeeded on the hash Apply synced", async () => {
    expect(await settle("applied", "success")).toMatchObject({
      phase: "deployed",
    });
    expect(await settle("other", "success")).toMatchObject({
      phase: "failed",
      error: "CI deployed a different manifest than Apply synced.",
    });
    expect(await settle("applied", "failure")).toMatchObject({
      phase: "failed",
      error: "CI failure.",
    });
  });

  test("a rerun that succeeds after a failure settles the Apply as deployed", async () => {
    const { t, stageId } = await seed("applied", 200);
    const run = (conclusion: string): Promise<null> =>
      t.mutation(internal.stageSources.verifyRun, {
        repoId: 7,
        branch: "dev",
        sha: SHA,
        conclusion: conclusion,
        url: "https://github.com/acme/app/actions/runs/1",
        startedAt: 100,
      });
    await run("failure");
    await run("success");

    expect(
      await t.run(
        async (ctx) =>
          (
            await ctx.db
              .query("stageSources")
              .withIndex("by_stageId_and_revision", (q) =>
                q.eq("stageId", stageId),
              )
              .first()
          )?.verification,
      ),
    ).toMatchObject({ phase: "deployed" });
  });

  test("a newer row CI stored for the same commit settles with the Apply", async () => {
    expect(await settle("applied", "success", true)).toMatchObject({
      phase: "deployed",
    });
  });
});
