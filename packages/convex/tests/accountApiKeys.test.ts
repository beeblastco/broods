/// <reference types="vite/client" />
/**
 * Scoped account keys: made on Organization › API access, then a `bask_`
 * bearer the config plane treats as a role over the key's own grid, pin and
 * expiry. Revoking or expiring one stops it at once.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import type { ApiErrorBody } from "../model/apiError";
import type { ApiPolicyAction } from "../model/policyRules";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "bask_test-owner-secret";
const AUTH_ID = "auth_owner";

type Seeded = {
  orgId: Id<"orgs">;
  accountId: Id<"accounts">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
};

type T = ReturnType<typeof keyTest>;

vi.mock(
  "../auth",
  (): { authKit: { getAuthUser: () => Promise<{ id: string }> } } => ({
    authKit: {
      getAuthUser: async (): Promise<{ id: string }> => ({ id: AUTH_ID }),
    },
  }),
);

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
  // http.ts mounts the WorkOS webhook only under WorkOS, which the mock lacks.
  vi.stubEnv("BROODS_AUTH_PROVIDER", "self-host");
});

describe("scoped account keys on config-plane routes", () => {
  test("a key holds exactly what its grid allows", async () => {
    const t = keyTest();
    const seeded = await seed(t);
    const { token } = await createKey(t, seeded, ["agents:read"]);
    expect(token).toMatch(/^bask_[A-Za-z0-9_-]{43}$/);

    expect((await get(t, token, "/v1/agents")).status).toBe(200);
    expect((await get(t, token, "/v1/crons")).status).toBe(403);
    const write = await t.fetch("/v1/agents/agent-1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(write.status).toBe(403);

    // Like a role session: no role management, no rotating the account key,
    // no minting sessions.
    expect((await get(t, token, "/v1/roles")).status).toBe(403);
    const rotate = await t.fetch("/v1/account/rotate-secret", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rotate.status).toBe(403);
    const assume = await t.fetch("/v1/account/assume-role", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roleId: "brole_any" }),
    });
    expect(assume.status).toBe(401);
  });

  test("a stage-pinned key is refused an account-wide collection", async () => {
    const t = keyTest();
    const seeded = await seed(t);
    const { token } = await createKey(t, seeded, ["agents:read"], {
      projectId: seeded.projectId,
      stageId: seeded.stageId,
    });

    const response = await get(t, token, "/v1/agents");
    expect(response.status).toBe(403);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.message).toContain("pinned");
  });

  test("an expired or revoked key stops authenticating", async () => {
    const t = keyTest();
    const seeded = await seed(t);
    const expiring = await createKey(t, seeded, ["agents:read"]);
    await t.run(async (ctx) => {
      await ctx.db.patch(expiring._id, { expiresAt: Date.now() - 1000 });
    });
    expect((await get(t, expiring.token, "/v1/agents")).status).toBe(401);

    const revoked = await createKey(t, seeded, ["agents:read"]);
    await t.mutation(api.accountApiKeys.remove, {
      orgId: seeded.orgId,
      keyId: revoked._id,
    });
    expect((await get(t, revoked.token, "/v1/agents")).status).toBe(401);
  });

  test("a request stamps lastUsedAt and an edit narrows the key at once", async () => {
    const t = keyTest();
    const seeded = await seed(t);
    const { _id, token } = await createKey(t, seeded, [
      "agents:read",
      "crons:read",
    ]);
    expect((await get(t, token, "/v1/crons")).status).toBe(200);
    const used = await t.run(async (ctx) => await ctx.db.get(_id));
    expect(used?.lastUsedAt).toBeGreaterThan(0);

    await t.mutation(api.accountApiKeys.update, {
      orgId: seeded.orgId,
      keyId: _id,
      name: "Reader",
      actions: ["agents:read"],
    });
    expect((await get(t, token, "/v1/crons")).status).toBe(403);
  });
});

describe("making scoped account keys", () => {
  test("the org list shows the account key, then each key's grid and audit row", async () => {
    const t = keyTest();
    const seeded = await seed(t);
    const { _id } = await createKey(t, seeded, [
      "agents:read",
      "agents:write",
      "env:read",
    ]);

    const listed = await t.query(api.apiKeys.listForOrg, {});
    expect(listed?.keys.map((key) => key.name)).toEqual([
      "Account key",
      "Grafana",
    ]);
    expect(listed?.keys[0].actions).toBeUndefined();
    expect(listed?.keys[1]).toMatchObject({
      _id: _id,
      actions: ["agents:read", "agents:write", "env:read"],
    });
    expect(listed?.stages).toEqual([
      {
        projectId: seeded.projectId,
        projectName: "demo-app",
        stageId: seeded.stageId,
        stageName: "Development",
      },
    ]);
    const audit = await t.run(
      async (ctx) => await ctx.db.query("auditEvents").collect(),
    );
    expect(audit.map((row) => [row.action, row.resource.kind])).toEqual([
      ["account-key-created", "accountApiKey"],
    ]);
  });

  test("create refuses an empty grid, a past expiry and another org's stage", async () => {
    const t = keyTest();
    const seeded = await seed(t);
    await expect(createKey(t, seeded, [])).rejects.toThrow(
      "Pick at least one permission",
    );
    await expect(
      createKey(t, seeded, ["agents:read"], { expiresAt: Date.now() - 1 }),
    ).rejects.toThrow("Expiry must be in the future");

    const foreign = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        authId: "auth_other",
        orgId: await ctx.db.insert("orgs", {
          name: "other",
          slug: "other",
          ownerAuthId: "auth_other",
          plan: "free",
          createdAt: Date.now(),
        }),
        name: "other-app",
        slug: "other-app",
        updatedAt: Date.now(),
      });
      const stageId = await ctx.db.insert("stages", {
        authId: "auth_other",
        projectId: projectId,
        name: "Development",
        kind: "development",
        isDefault: true,
        updatedAt: Date.now(),
      });

      return { projectId: projectId, stageId: stageId };
    });
    await expect(
      createKey(t, seeded, ["agents:read"], foreign),
    ).rejects.toThrow("must reference this account");
  });
});

async function createKey(
  t: T,
  seeded: Seeded,
  actions: ApiPolicyAction[],
  extra: {
    projectId?: Id<"projects">;
    stageId?: Id<"stages">;
    expiresAt?: number;
  } = {},
): Promise<{ _id: Id<"accountApiKeys">; token: string }> {
  return await t.mutation(api.accountApiKeys.create, {
    orgId: seeded.orgId,
    name: "Grafana",
    actions: actions,
    ...extra,
  });
}

async function get(t: T, token: string, path: string): Promise<Response> {
  return await t.fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function keyTest(): ReturnType<typeof convexTest> {
  return convexTest(schema, modules);
}

async function seed(t: T): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free",
      createdAt: now,
    });
    const userId = await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "owner@example.com",
      name: "Owner",
      plan: "free",
      activeOrgId: orgId,
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
      secretHash: await sha256Hex(ACCOUNT_SECRET),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
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
