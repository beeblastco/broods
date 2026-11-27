/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const AUTH_ID = "auth_owner";
const NODE_ID = "workspace-node";

// The mutations read their caller through the WorkOS component, absent from the test runtime.
vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: AUTH_ID }) },
}));

const modules = import.meta.glob("../**/*.ts");

type T = TestConvex<typeof schema>;

test("uploading a file again replaces the copy at that path", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const projectId = await seedProject(t);
  const older = await storeBlob(t, "old");
  const newer = await storeBlob(t, "new");

  await t.mutation(
    api.workspace.files.create,
    upload(projectId, "a.txt", older),
  );
  await t.mutation(
    api.workspace.files.create,
    upload(projectId, "a.txt", newer),
  );

  const rows = await t.query(api.workspace.files.list, {
    projectId: projectId,
    nodeId: NODE_ID,
  });
  expect(rows.map((row) => row.storageId)).toEqual([newer]);
  expect(await t.run(async (ctx) => await ctx.storage.get(older))).toBeNull();
});

test("a rename onto a name already taken is refused", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const projectId = await seedProject(t);
  await t.mutation(
    api.workspace.files.create,
    upload(projectId, "a.txt", await storeBlob(t, "a")),
  );
  const fileId = await t.mutation(
    api.workspace.files.create,
    upload(projectId, "b.txt", await storeBlob(t, "b")),
  );

  await expect(
    t.mutation(api.workspace.files.rename, {
      fileId: fileId,
      newName: "a.txt",
    }),
  ).rejects.toThrow("already exists");
});

function upload(
  projectId: Id<"projects">,
  path: string,
  storageId: Id<"_storage">,
): {
  projectId: Id<"projects">;
  nodeId: string;
  path: string;
  name: string;
  isFolder: boolean;
  storageId: Id<"_storage">;
} {
  return {
    projectId: projectId,
    nodeId: NODE_ID,
    path: path,
    name: path,
    isFolder: false,
    storageId: storageId,
  };
}

async function seedProject(t: T): Promise<Id<"projects">> {
  return await t.run(async (ctx): Promise<Id<"projects">> => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "example",
      slug: "example",
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "example",
      secretHash: "hash",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
  });
}

async function storeBlob(t: T, text: string): Promise<Id<"_storage">> {
  return await t.run(
    async (ctx): Promise<Id<"_storage">> =>
      await ctx.storage.store(new Blob([text])),
  );
}
