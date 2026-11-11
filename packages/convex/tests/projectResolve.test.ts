/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { resolveProject } from "../model/projectScope";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const AUTH_ID = "auth_owner";
const CLI_TOKEN = "bcli_project-resolve";
const SECRET_HASH = "hash-project-resolve";
const SPELLINGS = [
  "My Bot",
  "my bot",
  "my-bot",
  "my-bot-2",
  "MY BOT",
  "brand-new name",
];

const resolveTest = () => convexTest(schema, modules);

type T = ReturnType<typeof resolveTest>;

interface Seeded {
  orgId: Id<"orgs">;
  accountId: Id<"accounts">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
}

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

test("without the old duplicate pair, the CLI and GitHub routes reach the same project", async () => {
  const t = resolveTest();
  const { orgId, projectId } = await seed(t);
  await t.mutation(internal.cli.sync.setEnvBySecretHash, {
    secretHash: SECRET_HASH,
    project: "my bot",
    stage: "development",
    name: "API_TOKEN",
    value: "x",
    actorId: "user_cli",
    actorKind: "cli",
  });

  const routes = await Promise.all(
    SPELLINGS.map(async (name) => [
      await cliTarget(t, orgId, name),
      await t.query(internal.github.cliProject, { orgId: orgId, slug: name }),
    ]),
  );
  const env = await t.run(async (ctx) => ({
    projects: (await ctx.db.query("projects").collect()).length,
    envProject: (await ctx.db.query("environmentVariables").first())?.projectId,
  }));

  expect(routes).toEqual([
    [projectId, projectId],
    [projectId, projectId],
    [projectId, projectId],
    [null, null],
    [projectId, projectId],
    [null, null],
  ]);
  expect(env).toEqual({ projects: 1, envProject: projectId });
});

test("with the old duplicate pair, every spelling reaches the project it reached on dev", async () => {
  const t = resolveTest();
  const { orgId, projectId: a } = await seed(t);
  const b = await addCliDuplicate(t, orgId);

  const cli = await Promise.all(
    SPELLINGS.map((name) => cliTarget(t, orgId, name)),
  );
  const github = await Promise.all(
    SPELLINGS.map((name) =>
      t.query(internal.github.cliProject, { orgId: orgId, slug: name }),
    ),
  );

  // "MY BOT" had no CLI target on dev (sync created a third project); it now joins "My Bot".
  expect(cli).toEqual([a, b, a, b, a, null]);
  expect(github).toEqual([a, a, a, b, a, null]);
});

test("`broods github unlink` revokes the linked project's keys, and 404s on a project with no repo", async () => {
  const t = resolveTest();
  const seeded = await seed(t);
  await addCliDuplicate(t, seeded.orgId);
  const keyId = await link(t, seeded);

  const unlinked = await unlink(t, "my bot");
  const again = await unlink(t, "my bot");
  const other = await unlink(t, "my-bot-2");

  const after = await t.run(async (ctx) => ({
    repo: (await ctx.db.get(seeded.projectId))?.repo,
    key: await ctx.db.get(keyId),
  }));
  expect(unlinked.status).toBe(200);
  expect(after).toEqual({ repo: undefined, key: null });
  expect(again.status).toBe(404);
  expect((await again.json()).error.message).toBe(
    "My Bot has no linked repository.",
  );
  expect(other.status).toBe(404);
});

async function addCliDuplicate(
  t: T,
  orgId: Id<"orgs">,
): Promise<Id<"projects">> {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "my bot",
      slug: "my-bot-2",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: id,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: Date.now(),
    });

    return id;
  });
}

// The project every CLI route (stages, env, logs, sync) resolves `--project` to.
async function cliTarget(
  t: T,
  orgId: Id<"orgs">,
  name: string,
): Promise<Id<"projects"> | null> {
  return await t.run(
    async (ctx) => (await resolveProject(ctx, orgId, name))?._id ?? null,
  );
}

async function link(t: T, seeded: Seeded): Promise<Id<"deployKeys">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const keyId = await ctx.db.insert("deployKeys", {
      accountId: seeded.accountId,
      projectId: seeded.projectId,
      stageId: seeded.stageId,
      name: "GitHub",
      keyHash: "key-hash",
      keyHint: "bdk_…",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(seeded.projectId, {
      repo: {
        installationId: 1,
        repoId: 2,
        fullName: "acme/web",
        rootDirectory: "",
        developmentBranch: "main",
        deployKeyIds: [keyId],
        protectedSecrets: true,
      },
    });

    return keyId;
  });
}

async function seed(t: T): Promise<Seeded> {
  const tokenHash = await sha256Hex(CLI_TOKEN);

  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "owner@example.com",
      name: "Owner",
      plan: "free",
    });
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free",
      createdAt: now,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "owner",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: SECRET_HASH,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("cliTokens", {
      tokenHash: tokenHash,
      authId: AUTH_ID,
      orgId: orgId,
      accountId: accountId,
      status: "active",
      createdAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "My Bot",
      slug: "my-bot",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });

    return {
      orgId: orgId,
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Buffer.from(digest).toString("hex");
}

async function unlink(t: T, project: string): Promise<Response> {
  return await t.fetch(
    `/v1/account/github/link?project=${encodeURIComponent(project)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${CLI_TOKEN}` } },
  );
}
