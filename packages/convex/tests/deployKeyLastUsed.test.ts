/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const HOUR_MS = 60 * 60 * 1000;
const TOKEN = "bpdk_last-used-proof";

const lastUsedTest = () => convexTest(schema, modules);

type T = ReturnType<typeof lastUsedTest>;

beforeEach((): void => {
  vi.useFakeTimers();
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("a project key records when it was last used, at most once an hour", async () => {
  const t = lastUsedTest();
  const keyId = await seed(t);

  const first = Date.now();
  await listEnv(t);
  vi.advanceTimersByTime(HOUR_MS / 2);
  await listEnv(t);
  expect(await lastUsedAt(t, keyId)).toBe(first);

  vi.advanceTimersByTime(HOUR_MS / 2);
  await listEnv(t);
  expect(await lastUsedAt(t, keyId)).toBe(first + HOUR_MS);
});

async function lastUsedAt(
  t: T,
  keyId: Id<"deployKeys">,
): Promise<number | undefined> {
  return await t.run(async (ctx) => (await ctx.db.get(keyId))?.lastUsedAt);
}

async function listEnv(t: T): Promise<void> {
  const response = await t.fetch(
    "/v1/account/projects/demo-app/stages/production/env",
    { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  expect(response.status).toBe(200);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function seed(t: T): Promise<Id<"deployKeys">> {
  const keyHash = await sha256Hex(TOKEN);

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

    return await ctx.db.insert("deployKeys", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "CI",
      keyHash: keyHash,
      keyHint: "bpdk_…roof",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}
