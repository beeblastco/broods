/// <reference types="vite/client" />

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
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
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

describe("a CLI login on the account API", () => {
  test("acts as the account, audited as cli, and never rotates the key", async () => {
    const t = prefixTest();
    const cli = `bcli_${BODY}`;
    await seed(t, {
      accountKey: `bask_${BODY}`,
      runtimeKey: `bsk_${BODY}`,
      projectKey: `bpdk_${BODY}`,
      cliToken: cli,
    });

    expect((await get(t, "/v1/agents", cli)).status).toBe(200);
    const patched = await t.fetch("/v1/account", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${cli}` },
      body: JSON.stringify({ description: "from the dock" }),
    });
    expect(patched.status).toBe(200);
    const [token, events] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.query("cliTokens").first(),
        ctx.db.query("auditEvents").collect(),
      ]),
    );
    expect(events.map((event) => event.actor)).toContainEqual({
      kind: "cli",
      id: AUTH_ID,
    });
    const accountId = token?.accountId ?? "";
    for (const path of [
      "/v1/account/rotate-secret",
      `/v1/accounts/${accountId}/rotate-secret`,
    ]) {
      const rotated = await t.fetch(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${cli}` },
      });
      expect(rotated.status, path).toBe(403);
    }
  });

  test("stops resolving once its user is only a member", async () => {
    const t = prefixTest();
    const cli = `bcli_${BODY}`;
    await seed(t, {
      accountKey: `bask_${BODY}`,
      runtimeKey: `bsk_${BODY}`,
      projectKey: `bpdk_${BODY}`,
      cliToken: cli,
    });
    await t.run(async (ctx) => {
      const membership = await ctx.db.query("orgMembers").first();
      if (membership) await ctx.db.patch(membership._id, { role: "member" });
    });

    expect((await get(t, "/v1/agents", cli)).status).toBe(401);
    expect((await assumeRole(t, cli)).status).toBe(401);
  });

  test("logout revokes it while its user is demoted or its account disabled", async () => {
    for (const lapse of ["demoted", "disabled"] as const) {
      const t = prefixTest();
      const cli = `bcli_${BODY}`;
      await seed(t, {
        accountKey: `bask_${BODY}`,
        runtimeKey: `bsk_${BODY}`,
        projectKey: `bpdk_${BODY}`,
        cliToken: cli,
      });
      await t.run(async (ctx) => {
        const membership = await ctx.db.query("orgMembers").first();
        const account = await ctx.db.query("accounts").first();
        if (lapse === "demoted" && membership) {
          await ctx.db.patch(membership._id, { role: "member" });
        }
        if (lapse === "disabled" && account) {
          await ctx.db.patch(account._id, { status: "disabled" });
        }
      });

      const logout = await t.fetch("/v1/account/auth/token", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cli}` },
      });
      expect(logout.status, lapse).toBe(204);
      const token = await t.run(async (ctx) =>
        ctx.db.query("cliTokens").first(),
      );
      expect(token?.status, lapse).toBe("revoked");
    }
  });

  test("lent to the agent, it reads but never mints or manages a credential", async () => {
    const t = prefixTest();
    const cli = `bcli_${BODY}`;
    const lent = `bcli_lent${BODY}`;
    await seed(t, {
      accountKey: `bask_${BODY}`,
      runtimeKey: `bsk_${BODY}`,
      projectKey: `bpdk_${BODY}`,
      cliToken: cli,
    });
    await t.run(async (ctx) => {
      const token = await ctx.db.query("cliTokens").first();
      if (!token) return;
      await ctx.db.insert("cliTokens", {
        tokenHash: await sha256Hex(lent),
        authId: token.authId,
        orgId: token.orgId,
        accountId: token.accountId,
        status: "active",
        createdAt: Date.now(),
        lentToAgent: true,
      });
    });

    for (const path of [
      "/v1/agents",
      "/v1/roles",
      "/v1/account",
      "/v1/account/connections",
    ]) {
      expect((await get(t, path, lent)).status, path).toBe(200);
    }
    for (const [method, path] of [
      ["POST", "/v1/roles"],
      ["PATCH", "/v1/roles/brole_missing"],
      ["DELETE", "/v1/roles/brole_missing"],
      ["POST", "/v1/account/assume-role"],
      ["PUT", "/v1/account/connections/chatgpt"],
      ["POST", "/v1/account/connections/chatgpt/start"],
      ["DELETE", "/v1/account/connections/chatgpt"],
      ["POST", "/v1/account/rotate-secret"],
      ["PATCH", "/v1/account"],
      ["PUT", "/v1/audit/sink"],
    ] as const) {
      const response = await t.fetch(path, {
        method: method,
        headers: { Authorization: `Bearer ${lent}` },
        body: "{}",
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.text(), `${method} ${path}`).toContain(
        "lent to the agent",
      );
    }
    // The CLI plane does not know a lent login: no stage session, runtime key or signing secret.
    expect((await get(t, ENV_PATH, lent)).status).toBe(401);
    const session = await t.fetch("/v1/account/stage-session", {
      method: "POST",
      headers: { Authorization: `Bearer ${lent}` },
      body: JSON.stringify({ project: "demo-app", stage: "development" }),
    });
    expect(session.status).toBe(401);
    const logout = await t.fetch("/v1/account/auth/token", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${lent}` },
    });
    expect(logout.status).toBe(401);
    expect((await get(t, "/v1/agents", lent)).status).toBe(200);
    const lentRow = await t.run(async (ctx) =>
      ctx.db
        .query("cliTokens")
        .filter((q) => q.eq(q.field("lentToAgent"), true))
        .first(),
    );
    expect(lentRow?.status).toBe("active");
    // The user's own `broods login` keeps every route.
    expect((await assumeRole(t, cli)).status).toBe(404);
    const removed = await t.fetch("/v1/roles/brole_missing", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${cli}` },
    });
    expect(removed.status).toBe(404);
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
