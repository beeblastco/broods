/// <reference types="vite/client" />
import { createHash } from "node:crypto";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptAgentConfigBlob } from "../model/agentConfigCodec";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const SECRET = "test-config-secret";

const migrationTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = ReturnType<typeof migrationTest>;

afterEach(() => {
  vi.unstubAllEnvs();
});

test("backfillEnvironmentValueDigests stamps the sha256 of the stored value", async () => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  const t = migrationTest();
  const { projectId, stageId } = await seedStage(t);
  const encrypted = await encryptAgentConfigBlob(
    { value: "sk-live-1" },
    SECRET,
  );
  const variableId = await t.run(async (ctx) => {
    return await ctx.db.insert("environmentVariables", {
      projectId: projectId,
      stageId: stageId,
      name: "OPENAI_API_KEY",
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      updatedAt: Date.now(),
    });
  });

  expect(
    await t.mutation(internal.migrations.backfillEnvironmentValueDigests, {}),
  ).toEqual({ patched: 1, isDone: true });
  expect(
    (await t.run(async (ctx) => ctx.db.get(variableId)))?.valueDigest,
  ).toBe(createHash("sha256").update("sk-live-1").digest("hex"));
  // Re-running is a no-op.
  expect(
    await t.mutation(internal.migrations.backfillEnvironmentValueDigests, {}),
  ).toEqual({ patched: 0, isDone: true });
});

test("unsetSandboxTerminatedAt clears the dead field and nothing else", async () => {
  const t = migrationTest();
  const accountId = await seedAccount(t);
  const instanceId = await t.run(async (ctx) => {
    const now = Date.now();

    return await ctx.db.insert("sandboxInstances", {
      accountId: accountId,
      provider: "lambda",
      reservationKey: "reservation",
      externalId: "microvm-1",
      name: "box",
      status: "terminating",
      specs: { vcpu: 1, memoryMb: 512, storageGb: 1 },
      createdAt: now,
      lastUsedAt: now,
      terminatedAt: now,
    });
  });

  await t.mutation(internal.migrations.unsetSandboxTerminatedAt, {});

  const row = await t.run(async (ctx) => ctx.db.get(instanceId));
  expect(row?.terminatedAt).toBeUndefined();
  expect(row?.status).toBe("terminating");
});

test("deleteSkillRows empties the retired skills table", async () => {
  const t = migrationTest();
  const accountId = await seedAccount(t);
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("skills", {
      accountId: accountId,
      name: "crm-sync",
      s3Key: "skills/crm-sync.zip",
      createdAt: now,
      updatedAt: now,
    });
  });

  expect(await t.mutation(internal.migrations.deleteSkillRows, {})).toEqual({
    deleted: 1,
    isDone: true,
  });
  expect(await t.run(async (ctx) => ctx.db.query("skills").collect())).toEqual(
    [],
  );
});

async function seedAccount(t: T): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const now = Date.now();

    return await ctx.db.insert("accounts", {
      orgId: "org-placeholder",
      username: "migrations",
      secretHash: "hash",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedStage(
  t: T,
): Promise<{ projectId: Id<"projects">; stageId: Id<"stages"> }> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });

    return { projectId: projectId, stageId: stageId };
  });
}
