/// <reference types="vite/client" />
import cronsComponent from "@convex-dev/crons/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { sha256Hex } from "../model/accountSecrets";
import { STAGE_SOURCE_LIMITS } from "../model/stageSource";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const PROJECT = "heal";
const SECRET = "bask_secret_heal";
const SHA = "c".repeat(40);
const STAGE = "development";
const FILES = [{ path: "broods/index.ts", content: "export default {};" }];

type T = TestConvex<typeof schema>;

describe("a stage source whose stored file is gone", () => {
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("a deploy with identical files stores it again", async (): Promise<void> => {
    const tt = t();
    await seedAccount(tt);
    expect((await deploy(tt, FILES)).status).toBe(200);
    await tt.run(async (ctx) => {
      await ctx.storage.delete((await rows(ctx))[0].storageId);
    });

    expect((await deploy(tt, FILES)).status).toBe(200);

    const stored = await tt.run(async (ctx) => {
      const all = await rows(ctx);
      const blob = await ctx.storage.get(all[0].storageId);

      return { count: all.length, body: blob ? await blob.text() : null };
    });
    expect(stored.count).toBe(1);
    expect(stored.body && JSON.parse(stored.body)).toEqual({ files: FILES });
  });

  test("a deploy that drops the oldest revision lands when that file is gone", async (): Promise<void> => {
    const tt = t();
    await seedAccount(tt);
    expect((await deploy(tt, FILES)).status).toBe(200);
    await tt.run(async (ctx) => {
      const [first] = await rows(ctx);
      for (
        let revision = 2;
        revision <= STAGE_SOURCE_LIMITS.revisions;
        revision += 1
      )
        await ctx.db.insert("stageSources", {
          stageId: first.stageId,
          revision: revision,
          hash: `old-${revision}`,
          storageId: await ctx.storage.store(new Blob(["{}"])),
          fileCount: 1,
          bytes: 2,
          origin: "cli",
          createdAt: revision,
        });
      await ctx.storage.delete(first.storageId);
    });

    const changed = await deploy(tt, [
      { path: "broods/index.ts", content: "export default { a: 1 };" },
    ]);

    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await changed.json()).toMatchObject({
      sourceRevision: STAGE_SOURCE_LIMITS.revisions + 1,
    });
  });

  test("an Apply or Revert base whose file is gone reads as no source", async (): Promise<void> => {
    const tt = t();
    await seedAccount(tt);
    expect((await deploy(tt, FILES, SHA)).status).toBe(200);
    const stageId = await tt.run(async (ctx) => {
      const [row] = await rows(ctx);
      await ctx.storage.delete(row.storageId);

      return row.stageId;
    });

    expect(
      await tt.action(internal.agentDock.storedSource, {
        stageId: stageId,
        commitSha: SHA,
      }),
    ).toBeNull();
  });
});

function t(): T {
  const tt = convexTest(schema, modules);
  cronsComponent.register(tt);

  return tt;
}

async function deploy(
  tt: T,
  files: { path: string; content: string }[],
  commitSha?: string,
): Promise<Response> {
  return await tt.fetch(
    `/v1/account/projects/${PROJECT}/stages/${STAGE}/manifest`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        manifest: { version: 1, project: PROJECT, stage: STAGE, resources: [] },
        prune: false,
        source: {
          files: files,
          ...(commitSha ? { commitSha: commitSha } : {}),
        },
      }),
    },
  );
}

async function rows(ctx: QueryCtx): Promise<Doc<"stageSources">[]> {
  return await ctx.db.query("stageSources").collect();
}

async function seedAccount(tt: T): Promise<void> {
  const secretHash = await sha256Hex(SECRET);
  await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "heal",
      slug: "heal",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "heal-dev",
      secretHash: secretHash,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}
