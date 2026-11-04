/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  OBSERVABILITY_TICKET_TTL_MS,
  observabilityTicketExpiry,
  openObservabilityTicket,
  sealObservabilityTicket,
} from "../model/observabilityTicket";
import {
  openStageSessionTicket,
  sealStageSessionTicket,
} from "../model/stageSessionTicket";
import {
  openUserToken,
  userConversationKey,
  userConversationPrefix,
} from "../model/userToken";
import schema from "../schema";

const AUTH_ID = "user_01OBSERVE";
const SIGNING_SECRET = "bsig_observe";
const TICKET_SECRET = "ticket-secret";

vi.mock("../auth", () => ({
  authKit: {
    getAuthUser: async () => ({ id: AUTH_ID }),
    registerRoutes: (): void => {},
  },
}));

const modules = import.meta.glob("../**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seed(
  role: "admin" | "member" = "admin",
): Promise<TestConvex<typeof schema>> {
  vi.stubEnv(
    "BROODS_AGENT_URL",
    "https://gateway.example.com/v1/projects/broods/stages/production/agents/ep_1",
  );
  vi.stubEnv("BROODS_AGENT_ID", "agent_1");
  vi.stubEnv("BROODS_AGENT_RUNTIME_KEY", "bsk_runtime");
  vi.stubEnv("BROODS_AGENT_USER_TOKEN_SECRET", SIGNING_SECRET);
  vi.stubEnv("STAGE_TICKET_SECRET", TICKET_SECRET);
  vi.stubEnv("SERVICE_AUTH_SECRET", "service");
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "0".repeat(64));
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "acme",
      slug: "acme",
      ownerAuthId: "user_owner",
      plan: "free",
      createdAt: 0,
    });
    const userId = await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "o@example.com",
      name: "O",
      plan: "free",
      activeOrgId: orgId,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: role,
      createdAt: 0,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "acme",
      secretHash: "hash",
      status: "active",
      createdAt: 0,
      updatedAt: 0,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "app",
      slug: "app",
      updatedAt: 0,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: 0,
    });
    await ctx.db.insert("agentDeployments", {
      authId: AUTH_ID,
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      status: "active",
      endpointId: "ep_1",
      projectSlug: "app",
      stageSlug: "development",
      apiKeyHash: "h",
      keyHint: "k",
      apiKeyCiphertext: "c",
      apiKeyIv: "i",
      apiKeyTag: "t",
      updatedAt: 0,
    });
  });

  return t;
}

async function lentLogin(
  t: TestConvex<typeof schema>,
  conversationKey?: string,
): Promise<string> {
  const session = await t.mutation(
    api.agentDock.session,
    conversationKey ? { conversationKey: conversationKey } : {},
  );
  const opened = await openUserToken(session?.userToken ?? "", SIGNING_SECRET);

  return opened?.credential ?? "";
}

const open = (
  t: TestConvex<typeof schema>,
  credential: string,
  stage = "development",
): Promise<Response> =>
  t.fetch("/v1/account/observability-session", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project: "app", stage: stage }),
  });

const write = (
  t: TestConvex<typeof schema>,
  credential: string,
): Promise<Response> =>
  t.fetch("/v1/env/NEW_VAR", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value: "x" }),
  });

describe("the read-only logs ticket", () => {
  test("opens only as itself: not as a stage ticket, and no stage ticket opens as it", async () => {
    const ticket = await sealObservabilityTicket(
      {
        accountId: "a",
        endpointId: "e",
        projectSlug: "p",
        stageSlug: "s",
        expiresAt: Date.now() + 1000,
      },
      TICKET_SECRET,
    );
    const stage = await sealStageSessionTicket(
      {
        accountId: "a",
        endpointId: "e",
        projectId: "p",
        projectSlug: "p",
        stageId: "s",
        stageSlug: "s",
        expiresAt: Date.now() + 1000,
      },
      TICKET_SECRET,
    );
    // A swapped prefix, so only the key context can refuse it.
    const forged = `bdob_${stage.slice("bdts_".length)}`;

    expect(await openObservabilityTicket(ticket, TICKET_SECRET)).toMatchObject({
      stageSlug: "s",
    });
    expect(await openStageSessionTicket(ticket, TICKET_SECRET)).toBeNull();
    expect(await openObservabilityTicket(forged, TICKET_SECRET)).toBeNull();
    expect(await openObservabilityTicket(stage, TICKET_SECRET)).toBeNull();
  });

  test("never outlives the login that minted it", () => {
    expect(observabilityTicketExpiry(100, 150)).toBe(150);
    expect(observabilityTicketExpiry(100, undefined)).toBe(
      100 + OBSERVABILITY_TICKET_TTL_MS,
    );
    expect(
      observabilityTicketExpiry(100, 100 + OBSERVABILITY_TICKET_TTL_MS * 2),
    ).toBe(100 + OBSERVABILITY_TICKET_TTL_MS);
  });

  test("a lent login opens its stage's logs, audited, and can no longer write", async () => {
    const t = await seed();
    const login = await lentLogin(t, "dock-1");
    expect((await write(t, login)).status).not.toBe(403);

    const opened = await open(t, login);
    expect(opened.status).toBe(200);
    const { token } = (await opened.json()) as { token: string };
    expect(await openObservabilityTicket(token, TICKET_SECRET)).toMatchObject({
      projectSlug: "app",
      stageSlug: "development",
    });
    const refused = await write(t, login);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: "read_only_after_logs" },
    });
    const audit = await t.run(async (ctx) =>
      ctx.db.query("auditEvents").collect(),
    );
    expect(audit.map((row) => row.action)).toContain("observability.opened");
  });

  test("a login re-minted in that conversation stays read-only; another conversation does not", async () => {
    const t = await seed();
    expect((await open(t, await lentLogin(t, "dock-1"))).status).toBe(200);

    expect((await write(t, await lentLogin(t, "dock-1"))).status).toBe(403);
    expect((await write(t, await lentLogin(t, "dock-2"))).status).not.toBe(403);
  });

  test("pruning the login that read logs does not lift the conversation's read-only mark", async () => {
    const t = await seed();
    expect((await open(t, await lentLogin(t, "dock-1"))).status).toBe(200);
    await t.mutation(internal.cli.auth.pruneExpiredTokens, {
      now: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("cliTokens").collect()),
    ).toEqual([]);

    expect((await write(t, await lentLogin(t, "dock-1"))).status).toBe(403);
  });

  test("the dock's token runs only its conversation, under either spelling of it", async () => {
    const t = await seed();
    const session = await t.mutation(api.agentDock.session, {
      conversationKey: `${userConversationPrefix(AUTH_ID)}dock-1`,
    });
    const opened = await openUserToken(
      session?.userToken ?? "",
      SIGNING_SECRET,
    );
    if (!opened) throw new Error("no user token");

    expect(opened.conversations).toEqual(["dock-1"]);
    expect(userConversationKey(opened, "dock-1")).not.toBeNull();
    expect(userConversationKey(opened, "dock-2")).toBeNull();
    expect((await open(t, opened.credential ?? "")).status).toBe(200);
    // The mark holds for the bare key, the one other logins in this conversation carry.
    expect((await write(t, await lentLogin(t, "dock-1"))).status).toBe(403);
  });

  test("a null body is a 400", async () => {
    const t = await seed();
    const response = await t.fetch("/v1/account/observability-session", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await lentLogin(t, "dock-1")}`,
        "Content-Type": "application/json",
      },
      body: "null",
    });

    expect(response.status).toBe(400);
  });

  test("a lent login with no conversation cannot open logs", async () => {
    const t = await seed();

    expect((await open(t, await lentLogin(t))).status).toBe(403);
  });

  test("an unknown stage or a demoted member gets nothing", async () => {
    const t = await seed();
    const login = await lentLogin(t, "dock-1");

    expect((await open(t, login, "production")).status).toBe(403);
    await t.run(async (ctx) => {
      const member = await ctx.db.query("orgMembers").first();
      if (member) await ctx.db.patch(member._id, { role: "member" });
    });
    expect((await open(t, login)).status).toBe(403);
  });
});
