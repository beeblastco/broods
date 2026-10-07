/// <reference types="vite/client" />
/**
 * Every config-plane and CLI route routes a bearer by its `b` prefix. A key
 * minted under an old prefix gets 401 even when its hash is still stored,
 * and the same key reissued under the new prefix authenticates.
 */

import { convexTest, type TestConvex } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const AUTH_ID = "auth_owner";
const BODY = "aB3-_xYzaB3-_xYzaB3-_xYzaB3-_xYzaB3-_xYzabc";
const ENV_PATH = "/v1/account/projects/demo-app/stages/development/env";

const prefixTest = (): TestConvex<typeof schema> => convexTest(schema, modules);

type T = ReturnType<typeof prefixTest>;

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

describe("credential prefixes", () => {
  test("an old-prefix key gets 401 on every route, with its hash stored", async () => {
    const t = prefixTest();
    await seed(t, {
      accountKey: `ask_${BODY}`,
      runtimeKey: `sk_${BODY}`,
      projectKey: `pdk_${BODY}`,
      cliToken: `fp_cli_${BODY}`,
    });

    for (const key of [`ask_${BODY}`, `sk_${BODY}`, `fp_agent_${BODY}`]) {
      expect((await get(t, "/v1/agents", key)).status).toBe(401);
      expect((await assumeRole(t, key)).status, `${key} on assume-role`).toBe(
        401,
      );
    }
    for (const key of [`ask_${BODY}`, `pdk_${BODY}`, `fp_cli_${BODY}`]) {
      expect((await get(t, ENV_PATH, key)).status, key).toBe(401);
    }
    expect(
      (await get(t, "/v1/account/projects", `fp_cli_${BODY}`)).status,
    ).toBe(401);
  });

  test("the same keys under the b prefix authenticate", async () => {
    const t = prefixTest();
    await seed(t, {
      accountKey: `bask_${BODY}`,
      runtimeKey: `bsk_${BODY}`,
      projectKey: `bpdk_${BODY}`,
      cliToken: `bcli_${BODY}`,
    });

    expect((await get(t, "/v1/agents", `bask_${BODY}`)).status).toBe(200);
    // An unknown role is past auth: a refused caller would get 401.
    expect((await assumeRole(t, `bask_${BODY}`)).status).toBe(404);
    expect((await assumeRole(t, `bsk_${BODY}`)).status).toBe(404);
    for (const key of [`bask_${BODY}`, `bpdk_${BODY}`, `bcli_${BODY}`]) {
      expect((await get(t, ENV_PATH, key)).status, key).toBe(200);
    }
    expect((await get(t, "/v1/account/projects", `bcli_${BODY}`)).status).toBe(
      200,
    );
  });
});

async function assumeRole(t: T, bearer: string): Promise<Response> {
  return await t.fetch("/v1/account/assume-role", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ roleId: "brole_missing" }),
  });
}

async function get(t: T, path: string, bearer: string): Promise<Response> {
  return await t.fetch(path, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

async function seed(
  t: T,
  keys: {
    accountKey: string;
    runtimeKey: string;
    projectKey: string;
    cliToken: string;
  },
): Promise<void> {
  await t.run(async (ctx) => {
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
      secretHash: await sha256Hex(keys.accountKey),
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const userId = await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "owner@example.com",
      name: "Owner",
      plan: "free" as const,
      activeOrgId: orgId,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "owner" as const,
      createdAt: Date.now(),
    });
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: Date.now(),
    });
    const stageId: Id<"stages"> = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("agentDeployments", {
      authId: AUTH_ID,
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      status: "active" as const,
      endpointId: "ep-1",
      projectSlug: "demo-app",
      stageSlug: "development",
      apiKeyHash: await sha256Hex(keys.runtimeKey),
      keyHint: "hint",
      apiKeyCiphertext: "ct",
      apiKeyIv: "iv",
      apiKeyTag: "tag",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("deployKeys", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "ci",
      keyHash: await sha256Hex(keys.projectKey),
      keyHint: "hint",
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("cliTokens", {
      tokenHash: await sha256Hex(keys.cliToken),
      authId: AUTH_ID,
      orgId: orgId,
      accountId: accountId,
      status: "active" as const,
      createdAt: Date.now(),
    });
  });
}
