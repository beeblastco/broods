/// <reference types="vite/client" />

import { createHash } from "node:crypto";
import cronsComponent from "@convex-dev/crons/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import {
  MAX_CLI_SKILL_SYNC_BYTES,
  MAX_SKILL_BUNDLE_BYTES,
} from "../model/skillLimits";
import schema from "../schema";

// The skills bucket, in memory: key -> body and user metadata.
const { bucket, writes, failPrefixDelete } = vi.hoisted(() => ({
  bucket: new Map<
    string,
    { body: Uint8Array; metadata: Record<string, string> | undefined }
  >(),
  writes: { count: 0 },
  failPrefixDelete: { on: false },
}));

vi.mock("../model/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model/s3")>()),
  deleteS3Object: async (_bucket: string, key: string): Promise<void> => {
    bucket.delete(key);
  },
  // When failing, it removes every file but SKILL.md and then throws, as S3 can part way.
  deleteS3Prefix: async (_bucket: string, prefix: string): Promise<number> => {
    const keys = [...bucket.keys()].filter((key) => key.startsWith(prefix));
    for (const key of keys) {
      if (!failPrefixDelete.on || !key.endsWith("/SKILL.md"))
        bucket.delete(key);
    }
    if (failPrefixDelete.on) throw new Error("S3 delete failed part way");

    return keys.length;
  },
  headS3Object: async (
    _bucket: string,
    key: string,
  ): Promise<{ Metadata: Record<string, string> | undefined } | null> => {
    const object = bucket.get(key);

    return object ? { Metadata: object.metadata } : null;
  },
  writeS3Object: async (
    _bucket: string,
    key: string,
    body: string | Uint8Array,
    options: { metadata?: Record<string, string> } = {},
  ): Promise<number> => {
    writes.count += 1;
    bucket.set(key, {
      body: typeof body === "string" ? new TextEncoder().encode(body) : body,
      metadata: options.metadata,
    });

    return 0;
  },
}));

const modules = import.meta.glob("../**/*.ts");
// By path, untyped here: the CLI's sources do not typecheck under this package's config.
const CLI_SYNC_MODULE = new URL("../../broods/src/sync.ts", import.meta.url)
  .href;

const PROJECT = "skill-upload";
const SECRET = "bask_secret_skill_upload";
const SKILL_MD = "---\nname: docs\ndescription: Docs.\n---\n";
const PROD_NOTES = "# Notes from prod\n";
const DEV_NOTES = "# Notes from dev\n";

type T = TestConvex<typeof schema>;
type File = { path: string; text: string };
type Manifest = {
  version: 1;
  project: string;
  stage: string;
  resources: unknown[];
};
// The slice of `BroodsSyncClient` that `broods dev` and `broods deploy` drive.
interface SyncClient {
  getManifest(
    project: string,
    stage: string,
  ): Promise<{ revision: number } | null>;
  putManifest(
    manifest: Manifest,
    prune: boolean,
    rotateRuntimeKey?: boolean,
    revision?: number,
  ): Promise<unknown>;
}

const t = (): T => {
  const tt = convexTest(schema, modules);
  cronsComponent.register(tt);

  return tt;
};

beforeEach((): void => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  vi.stubEnv("SKILLS_BUCKET_NAME", "skills");
});
afterEach((): void => {
  vi.unstubAllEnvs();
  bucket.clear();
  writes.count = 0;
  failPrefixDelete.on = false;
});

test("a filesStorageId another row owns is refused before any read, and kept", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const owned = await store(tt, skillFiles(PROD_NOTES));
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

  const response = await putSkill(tt, "development", skillFiles(PROD_NOTES), {
    filesStorageId: owned,
  });

  expect(response.status).toBe(400);
  expect(await response.text()).toContain("already registered");
  expect(writes.count).toBe(0);
  expect(await blobExists(tt, owned)).toBe(true);
});

test("an unchanged re-sync is refused once another stage overwrote the account skill", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const prod = skillFiles(PROD_NOTES);
  const dev = skillFiles(DEV_NOTES);
  const upload = async (
    stage: string,
    files: File[],
  ): Promise<Id<"_storage">> => {
    const blob = await store(tt, files);
    const response = await putSkill(tt, stage, files, { filesStorageId: blob });
    expect(response.status).toBe(200);

    return blob;
  };

  const first = await upload("production", prod);
  expect(await blobExists(tt, first)).toBe(false);
  expect(await putSkill(tt, "production", prod, {})).toHaveProperty(
    "status",
    200,
  );
  await upload("development", dev);
  const written = writes.count;

  const stale = await putSkill(tt, "production", prod, {});
  expect(stale.status).toBe(409);
  expect(await stale.text()).toContain("skill_upload_required");
  expect(writes.count).toBe(written);
  expect(notes()).toBe(DEV_NOTES);

  await upload("production", prod);
  expect(notes()).toBe(PROD_NOTES);
});

test("broods dev sends its revision again after the server refused a held skill", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const uploads = { count: 0 };
  const dev = await cliClient(tt, uploads);
  const devFiles = largeSkillFiles(DEV_NOTES);
  const devSync = async (): Promise<unknown> => {
    const remote = await dev.getManifest(PROJECT, "development");

    return await dev.putManifest(
      cliManifest("development", devFiles),
      true,
      false,
      remote === null ? 0 : remote.revision,
    );
  };

  await devSync();
  await (
    await cliClient(tt, uploads)
  ).putManifest(cliManifest("production", largeSkillFiles(PROD_NOTES)), true);
  expect(notes()).toBe(PROD_NOTES);
  expect(uploads.count).toBe(2);

  await devSync();
  expect(uploads.count).toBe(3);
  expect(notes()).toBe(DEV_NOTES);
  await devSync();
  expect(uploads.count).toBe(3);
});

test("a delete that failed part way leaves the skill unheld", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const files = skillFiles(PROD_NOTES);
  const sync = async (synced: File[]): Promise<Response> =>
    await putSkill(tt, "development", synced, {
      filesStorageId: await store(tt, synced),
    });
  expect((await sync(files)).status).toBe(200);
  failPrefixDelete.on = true;
  expect((await sync(skillFiles(DEV_NOTES))).status).toBe(500);
  failPrefixDelete.on = false;
  expect(notes()).toBeUndefined();

  expect((await putSkill(tt, "development", files, {})).status).toBe(409);
});

test("two skills naming one blob are refused, and the stage stays free", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const files = skillFiles(PROD_NOTES);
  const blob = await store(tt, files);
  const declared = {
    source: "files",
    path: "skills/docs",
    files: files.map((file) => ({
      path: file.path,
      size: Buffer.byteLength(file.text),
      sha256: sha(Buffer.from(file.text)),
    })),
    filesStorageId: blob,
  };
  const response = await tt.fetch(
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
          resources: ["docs", "docs-copy"].map((name) => ({
            kind: "skill",
            name: name,
            config: declared,
          })),
        },
        prune: true,
      }),
    },
  );
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("used by another skill");

  expect(
    (
      await putSkill(tt, "development", files, {
        filesStorageId: await store(tt, files),
      })
    ).status,
  ).toBe(200);
});

test("an unchanged re-sync is refused when the project's canvas files are stale", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const files = skillFiles(PROD_NOTES);
  const blob = await store(tt, files);
  expect(
    (await putSkill(tt, "development", files, { filesStorageId: blob })).status,
  ).toBe(200);
  await tt.mutation(internal.cli.sync.replaceSkillNodeFilesBySecretHash, {
    secretHash: await sha256Hex(SECRET),
    project: PROJECT,
    stage: "development",
    skillName: "docs",
    files: [],
  });

  expect((await putSkill(tt, "development", files, {})).status).toBe(409);
});

test("a blob over the skill cap is refused at the claim, before it is read", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const big = await tt.run(
    async (ctx): Promise<Id<"_storage">> =>
      await ctx.storage.store(
        new Blob([new Uint8Array(MAX_SKILL_BUNDLE_BYTES + 1)]),
      ),
  );
  const tooBig = await putSkill(tt, "development", skillFiles(PROD_NOTES), {
    filesStorageId: big,
  });
  expect(tooBig.status).toBe(400);
  expect(await tooBig.text()).toContain("Uploaded file exceeds");
});

test("a failed sync deletes the blob it claimed", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const wrong = await store(tt, skillFiles(DEV_NOTES));
  const response = await putSkill(tt, "development", skillFiles(PROD_NOTES), {
    filesStorageId: wrong,
  });
  expect(response.status).toBe(400);
  expect(await blobExists(tt, wrong)).toBe(false);
  expect(writes.count).toBe(0);
});

test("declared sizes must be non-negative integers that slice the blob exactly", async (): Promise<void> => {
  const tt = t();
  await seedAccount(tt);
  const skill = Buffer.byteLength(SKILL_MD);
  const notesBytes = Buffer.byteLength(PROD_NOTES);
  const empty = sha(new Uint8Array());
  const prodSha = sha(Buffer.from(PROD_NOTES));
  // Each passed before: `subarray` clamps or truncates and the offsets still add up.
  const cases = [
    [
      { path: "SKILL.md", size: skill, sha256: sha(Buffer.from(SKILL_MD)) },
      { path: "notes.md", size: notesBytes + 1, sha256: prodSha },
      { path: "extra.md", size: -1, sha256: empty },
    ],
    [
      {
        path: "SKILL.md",
        size: skill + 0.5,
        sha256: sha(Buffer.from(SKILL_MD)),
      },
      { path: "notes.md", size: notesBytes - 0.5, sha256: prodSha },
    ],
  ];

  for (const declared of cases) {
    const blob = await store(tt, skillFiles(PROD_NOTES));
    const response = await putDeclared(tt, "development", declared, {
      filesStorageId: blob,
    });
    expect(response.status).toBe(400);
  }
  expect(writes.count).toBe(0);
});

async function blobExists(tt: T, id: Id<"_storage">): Promise<boolean> {
  return await tt.run(
    async (ctx): Promise<boolean> => (await ctx.db.system.get(id)) !== null,
  );
}

function notes(): string | undefined {
  const object = [...bucket.entries()].find(([key]) =>
    key.endsWith("/docs/notes.md"),
  )?.[1];

  return object ? new TextDecoder().decode(object.body) : undefined;
}

// A real `BroodsSyncClient` against the test backend; storage uploads land in its file storage.
async function cliClient(
  tt: T,
  uploads: { count: number },
): Promise<SyncClient> {
  const { BroodsSyncClient } = (await import(
    /* @vite-ignore */ CLI_SYNC_MODULE
  )) as {
    BroodsSyncClient: new (options: {
      baseUrl: string;
      token: string;
      fetch: (input: string, init?: RequestInit) => Promise<Response>;
    }) => SyncClient;
  };

  return new BroodsSyncClient({
    baseUrl: "https://convex.test",
    token: SECRET,
    fetch: async (input, init): Promise<Response> => {
      const url = new URL(input);
      if (url.pathname !== "/api/storage/upload") {
        return await tt.fetch(`${url.pathname}${url.search}`, init);
      }
      uploads.count += 1;
      const body = new Blob([init?.body as Uint8Array<ArrayBuffer>]);

      return Response.json({
        storageId: await tt.run(
          async (ctx): Promise<Id<"_storage">> => await ctx.storage.store(body),
        ),
      });
    },
  });
}

// The manifest `broods dev` compiles for one skill: files declared and sent base64.
function cliManifest(stage: string, files: File[]): Manifest {
  return {
    version: 1,
    project: PROJECT,
    stage: stage,
    resources: [
      {
        kind: "skill",
        name: "docs",
        config: {
          source: "files",
          path: "skills/docs",
          files: files.map((file) => ({
            path: file.path,
            size: Buffer.byteLength(file.text),
            sha256: sha(Buffer.from(file.text)),
            contentBase64: Buffer.from(file.text).toString("base64"),
            contentType: "text/markdown",
          })),
        },
      },
    ],
  };
}

async function putDeclared(
  tt: T,
  stage: string,
  files: Array<{ path: string; size: number; sha256: string }>,
  extra: { filesStorageId?: Id<"_storage"> },
): Promise<Response> {
  return await tt.fetch(
    `/v1/account/projects/${PROJECT}/stages/${stage}/manifest`,
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
          stage: stage,
          resources: [
            {
              kind: "skill",
              name: "docs",
              config: {
                source: "files",
                path: "skills/docs",
                files: files.map((file) => ({
                  ...file,
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

async function putSkill(
  tt: T,
  stage: string,
  files: File[],
  extra: { filesStorageId?: Id<"_storage"> },
): Promise<Response> {
  return await putDeclared(
    tt,
    stage,
    files.map((file) => ({
      path: file.path,
      size: Buffer.byteLength(file.text),
      sha256: sha(Buffer.from(file.text)),
    })),
    extra,
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

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Past the CLI's 4 MiB inline budget, so the CLI uploads it or sends it held.
function largeSkillFiles(notesText: string): File[] {
  return [
    ...skillFiles(notesText),
    { path: "big.md", text: "x".repeat(MAX_CLI_SKILL_SYNC_BYTES) },
  ];
}

function skillFiles(notesText: string): File[] {
  return [
    { path: "SKILL.md", text: SKILL_MD },
    { path: "notes.md", text: notesText },
  ];
}

async function store(tt: T, files: File[]): Promise<Id<"_storage">> {
  return await tt.run(
    async (ctx): Promise<Id<"_storage">> =>
      await ctx.storage.store(
        new Blob([files.map((file) => file.text).join("")]),
      ),
  );
}
