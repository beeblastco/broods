/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

type T = TestConvex<typeof schema>;

interface Scope {
  accountId: Id<"accounts">;
  serverId: Id<"mcp">;
}

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

test("the tokens round-trip sealed on the server's own row", async () => {
  const t = convexTest(schema, modules);
  const scope = await connectedServer(t);

  expect(
    await t.query(internal.account.mcp.loadConnection, scope),
  ).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
  const row = await server(t, scope);
  expect(JSON.stringify(row)).not.toContain('refresh"');
  expect(row?.connection?.clientId).toBe("client");
});

test("a new url drops the tokens, so they never reach another host", async () => {
  const t = convexTest(schema, modules);
  const scope = await connectedServer(t);

  await t.mutation(internal.account.mcp.update, {
    ...scope,
    url: "https://elsewhere.example.com/mcp",
  });

  expect(await t.query(internal.account.mcp.loadConnection, scope)).toBeNull();
  expect((await server(t, scope))?.connection).toBeUndefined();
});

test("deleting the server drops the tokens", async () => {
  const t = convexTest(schema, modules);
  const scope = await connectedServer(t);

  await t.mutation(internal.account.mcp.remove, scope);

  expect(await t.query(internal.account.mcp.loadConnection, scope)).toBeNull();
  expect((await server(t, scope))?.connectionCiphertext).toBeUndefined();
});

test("tokens for a url the server no longer has are not stored", async () => {
  const t = convexTest(schema, modules);
  const scope = await connectedServer(t);
  await t.mutation(internal.account.mcp.update, {
    ...scope,
    url: "https://elsewhere.example.com/mcp",
  });

  expect(
    await t.mutation(internal.account.mcp.setConnection, {
      ...scope,
      url: "https://mcp.example.com/mcp",
      clientId: "client",
      tokenUrl: "https://auth.example.com/token",
      resource: "https://mcp.example.com/mcp",
      expiresAt: 1,
      accessToken: "access",
      refreshToken: "refresh",
    }),
  ).toBe(false);
  expect((await server(t, scope))?.connection).toBeUndefined();
});

test("a refresh loses to a sign-in that landed after it loaded", async () => {
  const t = convexTest(schema, modules);
  const scope = await connectedServer(t);

  expect(
    await t.mutation(internal.account.mcp.saveRefreshedConnection, {
      ...scope,
      loadedUpdatedAt: -1,
      expiresAt: 2,
      accessToken: "stale",
      refreshToken: "stale",
    }),
  ).toBe(false);
});

async function connectedServer(t: T): Promise<Scope> {
  const scope = await t.run(async (ctx): Promise<Scope> => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "org",
      slug: "org",
      ownerAuthId: "auth_owner",
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "owner",
      secretHash: "hash",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "project",
      slug: "project",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "dev",
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });
    const serverId = await ctx.db.insert("mcp", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "linked",
      transport: "http" as const,
      url: "https://mcp.example.com/mcp",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });

    return { accountId: accountId, serverId: serverId };
  });
  await t.mutation(internal.account.mcp.setConnection, {
    ...scope,
    url: "https://mcp.example.com/mcp",
    clientId: "client",
    tokenUrl: "https://auth.example.com/token",
    resource: "https://mcp.example.com/mcp",
    expiresAt: 1,
    accessToken: "access",
    refreshToken: "refresh",
  });

  return scope;
}

async function server(t: T, scope: Scope): Promise<Doc<"mcp"> | null> {
  return await t.run((ctx) => ctx.db.get(scope.serverId));
}
