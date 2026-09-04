/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  claimUploadedBlob,
  OPEN_UPLOADS_PER_HOUR,
  UPLOAD_GRANT_WINDOW_MS,
} from "../model/uploads";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const uploadTest = () => convexTest(schema, modules);

type T = ReturnType<typeof uploadTest>;

async function seedAccount(t: T): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free" as const,
      createdAt: now,
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash-beeblast",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("upload grants", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("refuses the mint past the hourly cap and opens again when a grant expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const t = uploadTest();
    const accountId = await seedAccount(t);
    const grant = () =>
      t.mutation(internal.account.uploads.grant, {
        accountId: accountId,
        kind: "mcp",
      });

    for (let i = 0; i < OPEN_UPLOADS_PER_HOUR; i += 1) {
      expect(await grant()).toHaveProperty("uploadUrl");
    }
    const refused = await grant();
    expect(refused).toEqual({
      retryAt: Date.now() + UPLOAD_GRANT_WINDOW_MS,
    });

    vi.setSystemTime(Date.now() + UPLOAD_GRANT_WINDOW_MS + 1);
    expect(await grant()).toHaveProperty("uploadUrl");
  });

  test("quota is per account", async () => {
    const t = uploadTest();
    const first = await seedAccount(t);
    const second = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("orgs", {
        name: "other",
        slug: "other",
        ownerAuthId: "auth_other",
        plan: "free" as const,
        createdAt: Date.now(),
      });

      return await ctx.db.insert("accounts", {
        orgId: orgId,
        username: "other",
        secretHash: "hash-other",
        status: "active" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    for (let i = 0; i < OPEN_UPLOADS_PER_HOUR; i += 1) {
      await t.mutation(internal.account.uploads.grant, {
        accountId: first,
        kind: "workspace",
      });
    }
    expect(
      await t.mutation(internal.account.uploads.grant, {
        accountId: second,
        kind: "workspace",
      }),
    ).toHaveProperty("uploadUrl");
  });

  test("pruneOrphans deletes old unreferenced blobs and keeps referenced ones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T10:00:00Z"));
    const t = uploadTest();
    const { orphan, kept } = await t.run(async (ctx) => {
      const orphanId = await ctx.storage.store(new Blob(["orphan"]));
      const keptId = await ctx.storage.store(new Blob(["kept"]));
      const projectId = await ctx.db.insert("projects", {
        authId: "auth_owner",
        name: "demo",
        slug: "demo",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("workspaceFiles", {
        authId: "auth_owner",
        projectId: projectId,
        nodeId: "node-1",
        path: "kept.txt",
        name: "kept.txt",
        isFolder: false,
        storageId: keptId,
        sizeBytes: 4,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      return { orphan: orphanId, kept: keptId };
    });

    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    const result = await t.mutation(internal.account.uploads.pruneOrphans, {});
    expect(result).toEqual({ deleted: 1, isDone: true });
    await t.run(async (ctx) => {
      expect(await ctx.db.system.get(orphan)).toBeNull();
      expect(await ctx.db.system.get(kept)).not.toBeNull();
    });
  });
});

describe("claimUploadedBlob", () => {
  test("refuses a blob another workspace file already owns", async () => {
    const t = uploadTest();
    await t.run(async (ctx) => {
      const owned = await ctx.storage.store(new Blob(["owned"]));
      const fresh = await ctx.storage.store(new Blob(["fresh"]));
      const projectId = await ctx.db.insert("projects", {
        authId: "auth_owner",
        name: "demo",
        slug: "demo",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("workspaceFiles", {
        authId: "auth_owner",
        projectId: projectId,
        nodeId: "node-1",
        path: "owned.txt",
        name: "owned.txt",
        isFolder: false,
        storageId: owned,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      await expect(claimUploadedBlob(ctx, owned)).rejects.toThrow(
        /already registered/,
      );
      expect((await claimUploadedBlob(ctx, fresh)).size).toBe(5);
    });
  });
});
