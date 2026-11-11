/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const ACCOUNT_KEY = "bask_workspace_files_fixture_key";
const AUTH_ID = "auth_owner";
const NODE_ID = "workspace-node";
const SKILL_MD = "---\nname: fixture-skill\ndescription: A fixture\n---\nBody.";
const writeObject = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// The mutations read their caller through the WorkOS component, absent from the test runtime.
vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: AUTH_ID }) },
}));

vi.mock("../model/s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("../model/s3")>();

  return {
    ...original,
    deleteS3Prefix: vi.fn().mockResolvedValue(0),
    writeS3Object: writeObject,
  };
});

const modules = import.meta.glob("../**/*.ts");

type T = TestConvex<typeof schema>;

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

  const rows = await t.query(internal.workspace.files.listStoredFilesInternal, {
    authId: AUTH_ID,
    projectId: projectId,
    nodeId: NODE_ID,
  });
  expect(rows.map((row) => row.storageId)).toEqual([newer]);
  expect(await t.run(async (ctx) => await ctx.storage.get(older))).toBeNull();
});

test("the file list hides storage ids and Publish skill still reads the files", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const projectId = await seedProject(t);
  await t.mutation(
    api.workspace.files.create,
    upload(projectId, "SKILL.md", await storeBlob(t, SKILL_MD)),
  );

  const rows = await t.query(api.workspace.files.list, {
    projectId: projectId,
    nodeId: NODE_ID,
  });
  expect(rows.map((row) => row.path)).toEqual(["SKILL.md"]);
  expect(rows[0]).not.toHaveProperty("storageId");

  vi.stubEnv("SKILLS_BUCKET_NAME", "fixture-bucket");
  vi.stubGlobal("fetch", async (): Promise<Response> => new Response(SKILL_MD));
  const skill = await t.action(api.skillsPublic.publishSkill, {
    projectId: projectId,
    nodeId: NODE_ID,
    bearerToken: ACCOUNT_KEY,
  });
  expect(skill.name).toBe("fixture-skill");
  expect(writeObject).toHaveBeenCalledWith(
    "fixture-bucket",
    `${skill.path}/SKILL.md`,
    expect.anything(),
    expect.anything(),
  );
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
      secretHash: await sha256Hex(ACCOUNT_KEY),
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
