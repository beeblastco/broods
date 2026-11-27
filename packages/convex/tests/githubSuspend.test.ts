/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const INSTALLATION_ID = 42;
const WEBHOOK_SECRET = "webhook-secret";

const suspendTest = () => convexTest(schema, modules);

type T = ReturnType<typeof suspendTest>;

beforeEach(() => {
  vi.stubEnv("GITHUB_APP_ID", "1");
  vi.stubEnv("GITHUB_APP_SLUG", "broods");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "key");
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "client");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "client-secret");
  vi.stubEnv("GITHUB_APP_WEBHOOK_SECRET", WEBHOOK_SECRET);
});

test("a suspended App keeps the repo link and deploy keys, so unsuspend restores it", async () => {
  const t = suspendTest();
  const { projectId, deployKeyId } = await seed(t);

  for (const action of ["suspend", "unsuspend"]) {
    const response = await installationEvent(t, action);
    expect(response.status).toBe(204);
  }

  const state = await t.run(async (ctx) => ({
    repo: (await ctx.db.get(projectId))?.repo?.repoId,
    key: (await ctx.db.get(deployKeyId))?._id,
    installations: (await ctx.db.query("githubInstallations").collect()).length,
  }));
  expect(state).toEqual({ repo: 7, key: deployKeyId, installations: 1 });
});

test("an uninstalled App still unlinks the repo and revokes its keys", async () => {
  const t = suspendTest();
  const { projectId, deployKeyId } = await seed(t);

  await installationEvent(t, "deleted");

  const state = await t.run(async (ctx) => ({
    repo: (await ctx.db.get(projectId))?.repo,
    key: await ctx.db.get(deployKeyId),
  }));
  expect(state).toEqual({ repo: undefined, key: null });
});

async function installationEvent(t: T, action: string): Promise<Response> {
  const body = JSON.stringify({
    action: action,
    installation: { id: INSTALLATION_ID },
  });

  return await t.fetch("/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "installation",
      "x-hub-signature-256": await sign(body),
    },
    body: body,
  });
}

async function seed(
  t: T,
): Promise<{ projectId: Id<"projects">; deployKeyId: Id<"deployKeys"> }> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash-beeblast",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("githubInstallations", {
      orgId: orgId,
      installationId: INSTALLATION_ID,
      login: "octo",
      accountType: "Organization",
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Production",
      kind: "production",
      isDefault: true,
      updatedAt: now,
    });
    const deployKeyId = await ctx.db.insert("deployKeys", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "GitHub Actions",
      keyHash: "hash-key",
      keyHint: "bpdk_...abcd",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(projectId, {
      repo: {
        installationId: INSTALLATION_ID,
        repoId: 7,
        fullName: "octo/demo-app",
        rootDirectory: "",
        productionBranch: "main",
        deployKeyIds: [deployKeyId],
        protectedSecrets: true,
      },
    });

    return { projectId: projectId, deployKeyId: deployKeyId };
  });
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );

  return `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
