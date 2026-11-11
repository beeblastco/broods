/// <reference types="vite/client" />

import { createHash } from "node:crypto";
import cronsComponent from "@convex-dev/crons/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import type { SkillBundleFile } from "../model/skills";
import schema from "../schema";

const { createOrReplaceSkill } = vi.hoisted(() => ({
  createOrReplaceSkill: vi.fn(
    async (accountId: string, files: SkillBundleFile[]) => ({
      name: "docs",
      description: "Docs.",
      path: `${accountId}/docs`,
      files: files.map((file) => ({
        path: file.path,
        size: file.bytes.byteLength,
      })),
    }),
  ),
}));

vi.mock("../model/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model/skills")>()),
  createOrReplaceSkill: createOrReplaceSkill,
}));

const modules = import.meta.glob("../**/*.ts");

const PROJECT = "skill-upload";
const SECRET = "bask_secret_skill_upload";
const FILES = [
  { path: "SKILL.md", text: "---\nname: docs\ndescription: Docs.\n---\n" },
  { path: "notes.md", text: "# Notes\n" },
];

type T = TestConvex<typeof schema>;

const t = (): T => {
  const tt = convexTest(schema, modules);
  cronsComponent.register(tt);

  return tt;
};

beforeEach((): void => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});
afterEach((): void => {
  vi.unstubAllEnvs();
  createOrReplaceSkill.mockClear();
});

test("a filesStorageId another row owns is refused before any read, and kept", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const owned = await tt.run(
    async (ctx): Promise<Id<"_storage">> =>
      await ctx.storage.store(new Blob([upload()])),
  );
  await tt.run(async (ctx): Promise<void> => {
    await ctx.db.insert("stageSources", {
      stageId: (await ctx.db.query("stages").first())!._id,
      revision: 1,
      hash: "hash",
      storageId: owned,
      fileCount: 1,
      bytes: 1,
      origin: "cli",
      createdAt: Date.now(),
    });
  });

  const response = await putSkill(tt, { filesStorageId: owned });

  expect(response.status).toBe(400);
  expect(await response.text()).toContain("already registered");
  expect(createOrReplaceSkill).not.toHaveBeenCalled();
  expect(await blobExists(tt, owned)).toBe(true);
});

test("an uploaded skill is stored from its blob, which is then deleted; an unchanged re-sync writes nothing", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const blob = await tt.run(
    async (ctx): Promise<Id<"_storage">> =>
      await ctx.storage.store(new Blob([upload()])),
  );

  expect((await putSkill(tt, { filesStorageId: blob })).status).toBe(200);
  expect(createOrReplaceSkill).toHaveBeenCalledTimes(1);
  expect(
    createOrReplaceSkill.mock.calls[0]?.[1].map((file) =>
      new TextDecoder().decode(file.bytes),
    ),
  ).toEqual(FILES.map((file) => file.text));
  expect(await blobExists(tt, blob)).toBe(false);

  expect((await putSkill(tt, {})).status).toBe(200);
  expect(createOrReplaceSkill).toHaveBeenCalledTimes(1);
});

async function blobExists(tt: T, id: Id<"_storage">): Promise<boolean> {
  return await tt.run(
    async (ctx): Promise<boolean> => (await ctx.db.system.get(id)) !== null,
  );
}

async function putSkill(
  tt: T,
  extra: { filesStorageId?: Id<"_storage"> },
): Promise<Response> {
  return await tt.fetch(
    `/v1/account/projects/${PROJECT}/stages/development/manifest`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        manifest: {
          version: 1,
          project: PROJECT,
          stage: "development",
          resources: [
            {
              kind: "skill",
              name: "docs",
              config: {
                source: "files",
                path: "skills/docs",
                files: FILES.map((file) => ({
                  path: file.path,
                  size: Buffer.byteLength(file.text),
                  sha256: createHash("sha256").update(file.text).digest("hex"),
                  contentType: "text/markdown",
                })),
                ...extra,
              },
            },
          ],
        },
        prune: true,
      }),
    },
  );
}

async function seedAccount(tt: T): Promise<void> {
  const secretHash = await sha256Hex(SECRET);
  await tt.run(async (ctx): Promise<void> => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "skill-org",
      slug: "skill-org",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "skill-dev",
      secretHash: secretHash,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: PROJECT,
      slug: PROJECT,
      updatedAt: now,
    });
    await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });
  });
}

function upload(): string {
  return FILES.map((file) => file.text).join("");
}
