/// <reference types="vite/client" />
/**
 * Config-plane HTTP tests for account roles: the assume-role exchange
 * (account secret and stage runtime key callers), session expiry, disabled
 * roles, and route enforcement of a role session's policy.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import type { PolicyDocument } from "../model/policyRules";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "fp_acct_test-owner-secret";
const AGENTS_READ_POLICY: PolicyDocument = {
  version: 1,
  rules: [{ id: "read-agents", effect: "allow", actions: ["agents:read"] }],
};
const AUTH_ID = "auth_owner";
const RUNTIME_KEY = "fp_agent_test-runtime-key";

const roleTest = () => convexTest(schema, modules);

type T = ReturnType<typeof roleTest>;

type Seeded = {
  accountId: Id<"accounts">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
  otherStageId: Id<"stages">;
};

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

async function assumeRole(
  t: T,
  bearer: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await t.fetch("/v1/account/assume-role", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function createRole(
  t: T,
  seeded: Seeded,
  overrides: { scoped?: boolean; policy?: PolicyDocument } = {},
): Promise<string> {
  const created = await t.mutation(internal.account.roles.createInternal, {
    accountId: seeded.accountId,
    name: "reader",
    policy: overrides.policy ?? AGENTS_READ_POLICY,
    ...(overrides.scoped === true
      ? { projectId: seeded.projectId, stageId: seeded.stageId }
      : {}),
  });

  return created.roleId;
}

async function seed(t: T): Promise<Seeded> {
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
      secretHash: await sha256Hex(ACCOUNT_SECRET),
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
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: Date.now(),
    });
    const otherStageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Production",
      kind: "production" as const,
      isDefault: false,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("agentDeployments", {
      authId: AUTH_ID,
      accountId: accountId,
      projectId: projectId,
      stageId: otherStageId,
      status: "active" as const,
      endpointId: "ep-1",
      projectSlug: "demo-app",
      stageSlug: "production",
      apiKeyHash: await sha256Hex(RUNTIME_KEY),
      keyHint: "fp_agent_...-key",
      apiKeyCiphertext: "ct",
      apiKeyIv: "iv",
      apiKeyTag: "tag",
      updatedAt: Date.now(),
    });

    return {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      otherStageId: otherStageId,
    };
  });
}

describe("POST /v1/account/assume-role", () => {
  test("account secret mints a working fp_sts_ session", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const roleId = await createRole(t, seeded);

    const response = await assumeRole(t, ACCOUNT_SECRET, { roleId: roleId });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      expiresAt: string;
    };
    expect(body.token.startsWith("fp_sts_")).toBe(true);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

    const agents = await t.fetch("/v1/agents", {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(agents.status).toBe(200);
  });

  test("runtime key assumes only roles scoped to its own stage", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    // Scoped to the development stage; the runtime key deploys production.
    const mismatched = await createRole(t, seeded, { scoped: true });
    const denied = await assumeRole(t, RUNTIME_KEY, { roleId: mismatched });
    expect(denied.status).toBe(403);

    // An account-wide role is wider than the key's stage, so it is denied too.
    const accountWide = await createRole(t, seeded);
    const deniedWide = await assumeRole(t, RUNTIME_KEY, {
      roleId: accountWide,
    });
    expect(deniedWide.status).toBe(403);
  });

  test("disabled roles refuse the exchange", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const roleId = await createRole(t, seeded);
    await t.mutation(internal.account.roles.updateInternal, {
      accountId: seeded.accountId,
      roleId: roleId,
      status: "disabled" as const,
    });

    const response = await assumeRole(t, ACCOUNT_SECRET, { roleId: roleId });
    expect(response.status).toBe(403);
  });
});

describe("role sessions on config-plane routes", () => {
  test("expired sessions are unauthorized", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const roleId = await createRole(t, seeded);
    const token = "fp_sts_expired-token";
    const tokenHash = await sha256Hex(token);
    await t.run(async (ctx) => {
      await ctx.db.insert("roleSessions", {
        tokenHash: tokenHash,
        roleId: roleId,
        accountId: seeded.accountId,
        expiresAt: Date.now() - 1000,
        createdAt: Date.now() - 2000,
      });
    });

    const response = await t.fetch("/v1/agents", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });

  test("a session holds exactly what its policy allows", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const roleId = await createRole(t, seeded);
    const minted = await assumeRole(t, ACCOUNT_SECRET, { roleId: roleId });
    const { token } = (await minted.json()) as { token: string };

    const read = await t.fetch("/v1/agents", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);

    const write = await t.fetch("/v1/agents/agent-1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(write.status).toBe(403);

    // Role management is account-secret only, whatever the policy says.
    const roles = await t.fetch("/v1/roles", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(roles.status).toBe(403);

    // Sessions cannot chain into new sessions.
    const chained = await assumeRole(t, token, { roleId: roleId });
    expect(chained.status).toBe(401);
  });
});
