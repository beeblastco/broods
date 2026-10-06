/// <reference types="vite/client" />
/**
 * The two credential prefix migrations: stored runtime keys move to `bsk_`
 * keeping their random body, and role ids move to `brole_`. Both are
 * idempotent.
 */

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { decryptApiKey } from "../agent/deployments";
import { sha256Hex } from "../model/accountSecrets";
import { encryptAgentConfigBlob } from "../model/agentConfigCodec";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const AUTH_ID = "auth_owner";
const BODY = "aB3-_xYzaB3-_xYzaB3-_xYzaB3-_xYzaB3-_xYzabc";
const ENCRYPTION_SECRET = "test-config-secret";

const migrationTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = ReturnType<typeof migrationTest>;

type Seeded = {
  accountId: Id<"accounts">;
  projectId: Id<"projects">;
  stageIds: Id<"stages">[];
};

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", ENCRYPTION_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("migrations:runtimeKeyPrefix", () => {
  test("rebrands sk_ and fp_agent_ keys to bsk_ with the same body, once", async () => {
    const t = migrationTest();
    const seeded = await seed(t, 3);
    const keys = [`sk_${BODY}`, `fp_agent_${BODY}x`, `bsk_${BODY}y`];
    for (const [index, key] of keys.entries()) {
      await insertDeployment(t, seeded, seeded.stageIds[index], key);
    }

    expect(await t.mutation(internal.migrations.runtimeKeyPrefix, {})).toEqual({
      migrated: 2,
      skipped: 1,
      isDone: true,
    });

    const expected = [`bsk_${BODY}`, `bsk_${BODY}x`, `bsk_${BODY}y`];
    const rows = await t.run(
      async (ctx) => await ctx.db.query("agentDeployments").collect(),
    );
    for (const [index, row] of rows.entries()) {
      expect(await decryptApiKey(row)).toBe(expected[index]);
      expect(row.apiKeyHash).toBe(await sha256Hex(expected[index]));
      expect(row.keyHint).toBe(`bsk_…${expected[index].slice(-4)}`);
      expect(
        await t.query(internal.agent.deployments.getByApiKeyHash, {
          apiKeyHash: await sha256Hex(expected[index]),
        }),
      ).toMatchObject({ projectSlug: "demo-app" });
    }
    expect(
      await t.query(internal.agent.deployments.getByApiKeyHash, {
        apiKeyHash: await sha256Hex(`sk_${BODY}`),
      }),
    ).toBeNull();

    expect(await t.mutation(internal.migrations.runtimeKeyPrefix, {})).toEqual({
      migrated: 0,
      skipped: 3,
      isDone: true,
    });
  });
});

describe("migrations:roleIdPrefix", () => {
  test("rewrites fp_role_ ids in roles and their sessions, once", async () => {
    vi.useFakeTimers();
    const t = migrationTest();
    const seeded = await seed(t, 1);
    await t.run(async (ctx) => {
      for (const roleId of ["fp_role_abc", "brole_def"]) {
        await ctx.db.insert("accountRoles", {
          accountId: seeded.accountId,
          roleId: roleId,
          name: roleId,
          status: "active" as const,
          policy: { version: 1, rules: [] },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      await ctx.db.insert("roleSessions", {
        tokenHash: "session-hash",
        roleId: "fp_role_abc",
        accountId: seeded.accountId,
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      });
    });

    expect(await t.mutation(internal.migrations.roleIdPrefix, {})).toEqual({
      migrated: 1,
      skipped: 1,
      isDone: false,
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const roleIds = await t.run(async (ctx) => ({
      roles: (await ctx.db.query("accountRoles").collect()).map(
        (row) => row.roleId,
      ),
      sessions: (await ctx.db.query("roleSessions").collect()).map(
        (row) => row.roleId,
      ),
    }));
    expect(roleIds).toEqual({
      roles: ["brole_abc", "brole_def"],
      sessions: ["brole_abc"],
    });

    expect(
      await t.mutation(internal.migrations.roleIdPrefix, {
        table: "roleSessions",
      }),
    ).toEqual({ migrated: 0, skipped: 1, isDone: true });
  });
});

async function insertDeployment(
  t: T,
  seeded: Seeded,
  stageId: Id<"stages">,
  rawApiKey: string,
): Promise<void> {
  const blob = await encryptAgentConfigBlob(
    { value: rawApiKey },
    ENCRYPTION_SECRET,
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("agentDeployments", {
      authId: AUTH_ID,
      accountId: seeded.accountId,
      projectId: seeded.projectId,
      stageId: stageId,
      status: "active" as const,
      endpointId: `stage-${stageId.slice(-8)}`,
      projectSlug: "demo-app",
      stageSlug: "production",
      apiKeyHash: await sha256Hex(rawApiKey),
      keyHint: `${rawApiKey.slice(0, rawApiKey.indexOf("_") + 1)}…${rawApiKey.slice(-4)}`,
      apiKeyCiphertext: blob.ciphertext,
      apiKeyIv: blob.iv,
      apiKeyTag: blob.tag,
      updatedAt: Date.now(),
    });
  });
}

async function seed(t: T, stageCount: number): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: Date.now(),
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash-beeblast",
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: Date.now(),
    });
    const stageIds: Id<"stages">[] = [];
    for (let index = 0; index < stageCount; index += 1) {
      stageIds.push(
        await ctx.db.insert("stages", {
          authId: AUTH_ID,
          projectId: projectId,
          name: `Stage ${index}`,
          kind: "production" as const,
          isDefault: index === 0,
          updatedAt: Date.now(),
        }),
      );
    }

    return { accountId: accountId, projectId: projectId, stageIds: stageIds };
  });
}
