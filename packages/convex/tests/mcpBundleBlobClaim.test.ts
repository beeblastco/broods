/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const ACCOUNT_SECRET = "bask_bundle-blob-claim";
const MCP_PATH = "/v1/mcp?project=demo-app&stage=development";
const WRONG_SHA = "0".repeat(64);
const modules = import.meta.glob("../**/*.ts");

const claimTest = (): TestConvex<typeof schema> => convexTest(schema, modules);

type T = ReturnType<typeof claimTest>;

test("a bundleStorageId owned by another org's workspace file is refused and kept", async (): Promise<void> => {
  const t = claimTest();
  await seedCaller(t);
  const victim = await seedOtherOrgFile(t);

  const response = await postBundle(t, victim);

  expect(response.status).toBe(400);
  expect(await blobExists(t, victim)).toBe(true);
});

test("the caller's own upload is still deleted when its hash does not match", async (): Promise<void> => {
  const t = claimTest();
  await seedCaller(t);
  const upload = await t.run(
    async (ctx): Promise<Id<"_storage">> =>
      await ctx.storage.store(new Blob(["export default {}"])),
  );

  const response = await postBundle(t, upload);

  expect(response.status).toBe(400);
  expect(await blobExists(t, upload)).toBe(false);
});

async function blobExists(t: T, id: Id<"_storage">): Promise<boolean> {
  return await t.run(
    async (ctx): Promise<boolean> => (await ctx.db.system.get(id)) !== null,
  );
}

async function postBundle(t: T, storageId: Id<"_storage">): Promise<Response> {
  return await t.fetch(MCP_PATH, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCOUNT_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "tools",
      bundleStorageId: storageId,
      sha256: WRONG_SHA,
    }),
  });
}

async function seedCaller(t: T): Promise<void> {
  await t.run(async (ctx): Promise<void> => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "caller",
      slug: "caller",
      ownerAuthId: "auth_caller",
      plan: "free",
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "caller",
      secretHash: await sha256Hex(ACCOUNT_SECRET),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_caller",
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: now,
    });
    await ctx.db.insert("stages", {
      authId: "auth_caller",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });
  });
}

async function seedOtherOrgFile(t: T): Promise<Id<"_storage">> {
  return await t.run(async (ctx): Promise<Id<"_storage">> => {
    const now = Date.now();
    const storageId = await ctx.storage.store(new Blob(["private notes"]));
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_victim",
      orgId: await ctx.db.insert("orgs", {
        name: "victim",
        slug: "victim",
        ownerAuthId: "auth_victim",
        plan: "free",
        createdAt: now,
      }),
      name: "notes",
      slug: "notes",
      updatedAt: now,
    });
    await ctx.db.insert("workspaceFiles", {
      authId: "auth_victim",
      projectId: projectId,
      nodeId: "node-1",
      path: "notes.md",
      name: "notes.md",
      isFolder: false,
      storageId: storageId,
      createdAt: now,
      updatedAt: now,
    });

    return storageId;
  });
}
