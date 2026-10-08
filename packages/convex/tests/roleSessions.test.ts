/// <reference types="vite/client" />
/**
 * Config-plane HTTP tests for account roles: the assume-role exchange
 * (account key and runtime key callers), session expiry, disabled
 * roles, and route enforcement of a role session's policy.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import type { ApiErrorBody } from "../model/apiError";
import type { PolicyDocument } from "../model/policyRules";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "bask_test-owner-secret";
const AGENTS_READ_POLICY: PolicyDocument = {
  version: 1,
  rules: [{ id: "read-agents", effect: "allow", actions: ["agents:read"] }],
};
const AUTH_ID = "auth_owner";
const RUNTIME_KEY = "bsk_stage-runtime-key";

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
      keyHint: "bsk_...-key",
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
  test("account key mints a working bsts_ session", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const roleId = await createRole(t, seeded);

    const response = await assumeRole(t, ACCOUNT_SECRET, { roleId: roleId });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      expiresAt: string;
    };
    expect(body.token.startsWith("bsts_")).toBe(true);
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
    const token = "bsts_expired-token";
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

describe("stage-pinned role sessions", () => {
  const AGENTS_WRITE_POLICY: PolicyDocument = {
    version: 1,
    rules: [
      {
        id: "agents",
        effect: "allow",
        actions: ["agents:read", "agents:write"],
      },
    ],
  };

  async function insertAgent(
    t: T,
    seeded: Seeded,
    stageId: Id<"stages">,
    name: string,
  ): Promise<Id<"agents">> {
    return await t.run(async (ctx) => {
      const agentId = await ctx.db.insert("agents", {
        accountId: seeded.accountId,
        name: name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("agentConfigs", {
        authId: AUTH_ID,
        name: name,
        agentId: agentId,
        projectId: seeded.projectId,
        stageId: stageId,
        updatedAt: Date.now(),
      });

      return agentId;
    });
  }

  async function pinnedSession(t: T, seeded: Seeded): Promise<string> {
    // Pinned to the development stage.
    const roleId = await createRole(t, seeded, {
      scoped: true,
      policy: AGENTS_WRITE_POLICY,
    });
    const minted = await assumeRole(t, ACCOUNT_SECRET, { roleId: roleId });
    const { token } = (await minted.json()) as { token: string };

    return token;
  }

  function patchAgent(t: T, token: string, agentId: string): Promise<Response> {
    return t.fetch(`/v1/agents/${agentId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "patched" }),
    });
  }

  test("a dev-pinned role cannot PATCH or read a production agent", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const prodAgent = await insertAgent(
      t,
      seeded,
      seeded.otherStageId,
      "prod-agent",
    );
    const token = await pinnedSession(t, seeded);

    const write = await patchAgent(t, token, prodAgent);
    expect(write.status).toBe(403);
    const body = (await write.json()) as ApiErrorBody;
    expect(body.error.message).toContain("pinned");

    const read = await t.fetch(`/v1/agents/${prodAgent}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(403);

    const unchanged = await t.run(async (ctx) => await ctx.db.get(prodAgent));
    expect(unchanged?.description).toBeUndefined();
  });

  test("a dev-pinned role still acts on its own stage's agent", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const devAgent = await insertAgent(t, seeded, seeded.stageId, "dev-agent");
    const token = await pinnedSession(t, seeded);

    const read = await t.fetch(`/v1/agents/${devAgent}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);

    const write = await patchAgent(t, token, devAgent);
    expect(write.status).toBe(200);
  });

  test("a dev-pinned role cannot point its cron at a production agent", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const devAgent = await insertAgent(t, seeded, seeded.stageId, "dev-agent");
    const prodAgent = await insertAgent(
      t,
      seeded,
      seeded.otherStageId,
      "prod-agent",
    );
    const cronId = await t.run(
      async (ctx) =>
        await ctx.db.insert("crons", {
          accountId: seeded.accountId,
          name: "nightly",
          agentId: devAgent,
          events: [],
          scheduleExpression: "rate(1 day)",
          status: "paused" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
    );
    const roleId = await createRole(t, seeded, {
      scoped: true,
      policy: {
        version: 1,
        rules: [{ id: "crons", effect: "allow", actions: ["crons:write"] }],
      },
    });
    const minted = await assumeRole(t, ACCOUNT_SECRET, { roleId: roleId });
    const { token } = (await minted.json()) as { token: string };

    const response = await t.fetch(`/v1/crons/${cronId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentId: prodAgent }),
    });
    expect(response.status).toBe(400);
    const cron = await t.run(async (ctx) => await ctx.db.get(cronId));
    expect(cron?.agentId).toBe(devAgent);
  });

  test("a dev-pinned role cannot wire its agent or channel to production", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const devAgent = await insertAgent(t, seeded, seeded.stageId, "dev-agent");
    const prodAgent = await insertAgent(
      t,
      seeded,
      seeded.otherStageId,
      "prod-agent",
    );
    const { prodSandbox, devChannel } = await t.run(async (ctx) => ({
      prodSandbox: await ctx.db.insert("sandboxConfigs", {
        accountId: seeded.accountId,
        projectId: seeded.projectId,
        stageId: seeded.otherStageId,
        name: "prod-box",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      devChannel: await ctx.db.insert("channelRecords", {
        accountId: seeded.accountId,
        projectId: seeded.projectId,
        stageId: seeded.stageId,
        platform: "slack",
        externalId: "C1",
        name: "dev-channel",
        config: { agentBindings: [{ agentId: devAgent }] },
        status: "active" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    }));
    const roleId = await createRole(t, seeded, {
      scoped: true,
      policy: {
        version: 1,
        rules: [
          {
            id: "write",
            effect: "allow",
            actions: ["agents:write", "channels:write"],
          },
        ],
      },
    });
    const minted = await assumeRole(t, ACCOUNT_SECRET, { roleId: roleId });
    const { token } = (await minted.json()) as { token: string };
    const patch = (path: string, body: unknown): Promise<Response> =>
      t.fetch(path, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const agent = await patch(`/v1/agents/${devAgent}`, {
      config: { sandboxes: [prodSandbox] },
    });
    expect(agent.status).toBe(400);
    expect(((await agent.json()) as ApiErrorBody).error.message).toContain(
      `sandboxes ${prodSandbox}`,
    );

    const channel = await patch(`/v1/channels/${devChannel}`, {
      config: { agentBindings: [{ agentId: prodAgent }] },
    });
    expect(channel.status).toBe(400);
    const record = await t.run(async (ctx) => await ctx.db.get(devChannel));
    expect(record?.config.agentBindings).toEqual([{ agentId: devAgent }]);
  });

  test("a dev-pinned role cannot name an account env var in its agent", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const devAgent = await insertAgent(t, seeded, seeded.stageId, "dev-agent");
    await t.mutation(internal.account.envVars.set, {
      accountId: seeded.accountId,
      name: "PROD_DB_PASSWORD",
      value: "hunter2",
    });
    const token = await pinnedSession(t, seeded);

    const response = await t.fetch(`/v1/agents/${devAgent}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config: { systemPrompt: "leak ${PROD_DB_PASSWORD}" },
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.message).toContain(
      "PROD_DB_PASSWORD",
    );
    const agent = await t.run(async (ctx) => await ctx.db.get(devAgent));
    expect(agent?.encryptedConfig).toBeUndefined();

    // A name the config already carries stays where it was put, but the role
    // may not move it into a section it changes.
    const set = await t.fetch(`/v1/agents/${devAgent}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ACCOUNT_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        config: { systemPrompt: "use ${PROD_DB_PASSWORD}" },
      }),
    });
    expect(set.status).toBe(200);
    const patch = (body: unknown): Promise<Response> =>
      t.fetch(`/v1/agents/${devAgent}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect((await patch({ description: "kept" })).status).toBe(200);
    expect(
      (await patch({ config: { systemPrompt: "say ${PROD_DB_PASSWORD}" } }))
        .status,
    ).toBe(400);
  });

  test("an unpinned role cannot create an agent naming an env var it cannot read", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    await t.mutation(internal.account.envVars.set, {
      accountId: seeded.accountId,
      name: "PROD_DB_PASSWORD",
      value: "hunter2",
    });
    const roleId = await createRole(t, seeded, {
      policy: {
        version: 1,
        rules: [{ id: "agents", effect: "allow", actions: ["agents:write"] }],
      },
    });
    const minted = await assumeRole(t, ACCOUNT_SECRET, { roleId: roleId });
    const { token } = (await minted.json()) as { token: string };

    const response = await t.fetch("/v1/agents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "leaky",
        config: { systemPrompt: "leak ${PROD_DB_PASSWORD}" },
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.message).toContain(
      "PROD_DB_PASSWORD",
    );
  });

  test("a dev-pinned role cannot list or create account-wide", async () => {
    const t = roleTest();
    const seeded = await seed(t);
    const token = await pinnedSession(t, seeded);

    const list = await t.fetch("/v1/agents", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(403);

    const create = await t.fetch("/v1/agents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "sneaky" }),
    });
    expect(create.status).toBe(403);
  });
});

describe("POST /v1/roles", () => {
  test("rejects the retired tools:write action with a 400", async () => {
    const t = roleTest();
    await seed(t);

    const response = await t.fetch("/v1/roles", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCOUNT_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "tool-writer",
        policy: {
          version: 1,
          rules: [{ id: "tools", effect: "allow", actions: ["tools:write"] }],
        },
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.message).toContain("actions[] must be one of");
    expect(body.error.message).not.toContain("tools:");
  });
});
