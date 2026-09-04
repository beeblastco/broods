/// <reference types="vite/client" />
/** MCP server registrations: stage scope, per-stage name uniqueness, input validation. */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeMcpInput } from "../model/mcp";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const SERVER_NAME = "search";
const SERVER_URL = "https://mcp.example.com/mcp";

type Scope = {
  accountId: Id<"accounts">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
};

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

/** An org, account, project and one stage — the scope a server hangs off. */
async function seedScope(tt: T, stage = "Development"): Promise<Scope> {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner@example.com",
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast-dev",
      secretHash: "hash-mcp-scope",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner@example.com",
      orgId: orgId,
      name: "mcp-connect",
      slug: "mcp-connect",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner@example.com",
      projectId: projectId,
      name: stage,
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });

    return {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}

async function seedServer(
  tt: T,
  scope: Scope,
  name = SERVER_NAME,
): Promise<Id<"mcp">> {
  return await tt.mutation(internal.account.mcp.create, {
    accountId: scope.accountId,
    projectId: scope.projectId,
    stageId: scope.stageId,
    name: name,
    url: SERVER_URL,
    headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
  });
}

describe("MCP servers are scoped to a stage", () => {
  test("create and listForStage round-trip", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const serverId = await seedServer(tt, scope);

    const listed = await tt.query(internal.account.mcp.listForStage, {
      stageId: scope.stageId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?._id).toBe(serverId);
    expect(listed[0]?.transport).toBe("http");
    expect(listed[0]?.url).toBe(SERVER_URL);
  });

  test("an active name cannot be claimed twice on one stage", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    await seedServer(tt, scope);

    await expect(seedServer(tt, scope)).rejects.toThrow(
      "name must be unique per stage",
    );
  });

  test("the same name in two stages stays two rows", async () => {
    const tt = t();
    const first = await seedScope(tt);
    const secondStageId = await tt.run(async (ctx) => {
      return await ctx.db.insert("stages", {
        authId: "auth_owner@example.com",
        projectId: first.projectId,
        name: "Production",
        kind: "production" as const,
        isDefault: false,
        updatedAt: Date.now(),
      });
    });
    await seedServer(tt, first);
    await seedServer(tt, { ...first, stageId: secondStageId });

    const firstListed = await tt.query(internal.account.mcp.listForStage, {
      stageId: first.stageId,
    });
    const secondListed = await tt.query(internal.account.mcp.listForStage, {
      stageId: secondStageId,
    });
    expect(firstListed).toHaveLength(1);
    expect(secondListed).toHaveLength(1);
    expect(firstListed[0]?._id).not.toBe(secondListed[0]?._id);
  });

  test("soft delete frees the name and hides the row", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const serverId = await seedServer(tt, scope);
    await tt.mutation(internal.account.mcp.remove, {
      accountId: scope.accountId,
      serverId: serverId,
    });

    const listed = await tt.query(internal.account.mcp.listForStage, {
      stageId: scope.stageId,
    });
    expect(listed).toHaveLength(0);
    const fetched = await tt.query(internal.account.mcp.getById, {
      accountId: scope.accountId,
      serverId: serverId,
    });
    expect(fetched).toBeNull();
    await expect(seedServer(tt, scope)).resolves.toBeDefined();
  });

  test("soft delete releases the canvas node so a redeploy is visible", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const serverId = await seedServer(tt, scope);
    const nodeId = `cli-mcp-${SERVER_NAME}`;
    await tt.run(async (ctx) => {
      await ctx.db.patch(serverId, { nodeId: nodeId });
    });

    await tt.mutation(internal.account.mcp.remove, {
      accountId: scope.accountId,
      serverId: serverId,
    });

    // The tombstone must not keep the node id: the row a redeploy creates
    // claims the same deterministic id, and the canvas resolves by that pair.
    const deleted = await tt.run(async (ctx) => await ctx.db.get(serverId));
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.nodeId).toBeUndefined();

    const recreatedId = await seedServer(tt, scope);
    await tt.run(async (ctx) => {
      await ctx.db.patch(recreatedId, { nodeId: nodeId });
    });
    const sharingNode = await tt.run(async (ctx) => {
      return await ctx.db
        .query("mcp")
        .withIndex("by_stageId_and_nodeId", (q) =>
          q.eq("stageId", scope.stageId).eq("nodeId", nodeId),
        )
        .collect();
    });
    expect(sharingNode).toHaveLength(1);
    expect(sharingNode[0]?._id).toBe(recreatedId);
  });

  test("update renames within the stage uniqueness guard", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const serverId = await seedServer(tt, scope);
    await seedServer(tt, scope, "docs");

    await expect(
      tt.mutation(internal.account.mcp.update, {
        accountId: scope.accountId,
        serverId: serverId,
        name: "docs",
      }),
    ).rejects.toThrow("name must be unique per stage");
    await tt.mutation(internal.account.mcp.update, {
      accountId: scope.accountId,
      serverId: serverId,
      name: "search-v2",
      disabled: true,
    });
    const updated = await tt.query(internal.account.mcp.getById, {
      accountId: scope.accountId,
      serverId: serverId,
    });
    expect(updated?.name).toBe("search-v2");
    expect(updated?.disabled).toBe(true);
  });
});

describe("normalizeMcpInput", () => {
  test("accepts a full registration", async () => {
    const input = await normalizeMcpInput(
      {
        name: "search",
        description: "Company search backend.",
        url: SERVER_URL,
        headers: { Authorization: "Bearer ${SEARCH_TOKEN}" },
        allowedTools: ["query", "fetch_doc"],
      },
      { requireConnection: true },
    );
    expect(input.name).toBe("search");
    expect(input.allowedTools).toEqual(["query", "fetch_doc"]);
  });

  test("requires name and url on create", async () => {
    await expect(
      normalizeMcpInput({ url: SERVER_URL }, { requireConnection: true }),
    ).rejects.toThrow("name must be provided");
    await expect(
      normalizeMcpInput({ name: "search" }, { requireConnection: true }),
    ).rejects.toThrow("url must be provided");
  });

  test("rejects names that break the server__tool namespace", async () => {
    for (const name of ["Search", "se_arch", "1search", "a".repeat(33), ""]) {
      await expect(
        normalizeMcpInput(
          { name: name, url: SERVER_URL },
          { requireConnection: true },
        ),
      ).rejects.toThrow("name must be");
    }
  });

  test("rejects inline secrets in credential headers", async () => {
    await expect(
      normalizeMcpInput(
        {
          name: "search",
          url: SERVER_URL,
          headers: { Authorization: "Bearer sk-live-1234" },
        },
        { requireConnection: true },
      ),
    ).rejects.toThrow("headers values for Authorization must reference");
    await expect(
      normalizeMcpInput(
        {
          name: "search",
          url: SERVER_URL,
          headers: { "X-Api-Key": "raw-secret" },
        },
        { requireConnection: true },
      ),
    ).rejects.toThrow("headers values for X-Api-Key must reference");
  });

  test("rejects urls embedding credentials", async () => {
    await expect(
      normalizeMcpInput(
        { name: "search", url: "https://user:pass@mcp.example.com/mcp" },
        { requireConnection: true },
      ),
    ).rejects.toThrow("url must not embed credentials");
  });

  test("rejects non-http urls and header injection", async () => {
    await expect(
      normalizeMcpInput(
        { name: "search", url: "ftp://mcp.example.com" },
        { requireConnection: true },
      ),
    ).rejects.toThrow("url must use http or https");
    await expect(
      normalizeMcpInput(
        { name: "search", url: "not a url" },
        { requireConnection: true },
      ),
    ).rejects.toThrow("url must be a valid absolute URL");
    await expect(
      normalizeMcpInput(
        {
          name: "search",
          url: SERVER_URL,
          headers: { Authorization: "Bearer x\r\nHost: evil" },
        },
        { requireConnection: true },
      ),
    ).rejects.toThrow("headers values must be single-line");
  });

  test("accepts oauth whose secret fields are env refs", async () => {
    const input = await normalizeMcpInput(
      {
        name: "gmail",
        url: SERVER_URL,
        oauth: {
          clientId: "client-1.apps.googleusercontent.com",
          clientSecret: "${GMAIL_CLIENT_SECRET}",
          refreshToken: "${GMAIL_REFRESH_TOKEN}",
          tokenUrl: "https://oauth2.googleapis.com/token",
        },
      },
      { requireConnection: true },
    );
    expect(input.oauth).toEqual({
      clientId: "client-1.apps.googleusercontent.com",
      clientSecret: "${GMAIL_CLIENT_SECRET}",
      refreshToken: "${GMAIL_REFRESH_TOKEN}",
      tokenUrl: "https://oauth2.googleapis.com/token",
    });
  });

  test("rejects inline secrets in oauth fields", async () => {
    for (const field of ["clientSecret", "refreshToken"]) {
      await expect(
        normalizeMcpInput(
          {
            name: "gmail",
            url: SERVER_URL,
            oauth: {
              clientId: "client-1",
              clientSecret: "${GMAIL_CLIENT_SECRET}",
              refreshToken: "${GMAIL_REFRESH_TOKEN}",
              [field]: "raw-secret-value",
            },
          },
          { requireConnection: true },
        ),
      ).rejects.toThrow(`oauth.${field} must reference an account env var`);
    }
  });

  test("rejects a plain-http oauth token endpoint", async () => {
    await expect(
      normalizeMcpInput(
        {
          name: "gmail",
          url: SERVER_URL,
          oauth: {
            clientId: "client-1",
            clientSecret: "${GMAIL_CLIENT_SECRET}",
            refreshToken: "${GMAIL_REFRESH_TOKEN}",
            tokenUrl: "http://oauth.example.com/token",
          },
        },
        { requireConnection: true },
      ),
    ).rejects.toThrow("oauth.tokenUrl must use https");
  });

  test("update checks oauth against the row the patch produces", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const serverId = await seedServer(tt, scope);
    const oauth = {
      clientId: "client-1",
      clientSecret: "${GMAIL_CLIENT_SECRET}",
      refreshToken: "${GMAIL_REFRESH_TOKEN}",
    };

    // The seeded row carries an Authorization header; oauth alone conflicts.
    await expect(
      tt.mutation(internal.account.mcp.update, {
        accountId: scope.accountId,
        serverId: serverId,
        oauth: oauth,
      }),
    ).rejects.toThrow("oauth mints the Authorization header itself");
    await tt.mutation(internal.account.mcp.update, {
      accountId: scope.accountId,
      serverId: serverId,
      headers: {},
      oauth: oauth,
    });
    // Now the stored oauth conflicts with a header the patch brings back.
    await expect(
      tt.mutation(internal.account.mcp.update, {
        accountId: scope.accountId,
        serverId: serverId,
        headers: { authorization: "Bearer ${SEARCH_TOKEN}" },
      }),
    ).rejects.toThrow("drop the explicit authorization header");
  });

  test("create checks the oauth invariants on the row it writes", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const oauth = {
      clientId: "client-1",
      clientSecret: "${GMAIL_CLIENT_SECRET}",
      refreshToken: "${GMAIL_REFRESH_TOKEN}",
    };
    const create = (args: Record<string, unknown>): Promise<Id<"mcp">> =>
      tt.mutation(internal.account.mcp.create, {
        accountId: scope.accountId,
        projectId: scope.projectId,
        stageId: scope.stageId,
        name: "gmail",
        oauth: oauth,
        ...args,
      });

    await expect(
      create({ url: SERVER_URL, headers: { authorization: "Bearer x" } }),
    ).rejects.toThrow("oauth mints the Authorization header itself");
    await expect(
      create({ url: "http://gmail.example.com/mcp" }),
    ).rejects.toThrow("oauth needs an https url");
    await expect(
      create({
        transport: "hosted",
        bundleStorageKey: "account-mcp/acct/bundles/x.mjs",
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow("oauth applies to external (url) servers");
    await create({ url: SERVER_URL });
  });

  test("a patch may carry any subset", async () => {
    const input = await normalizeMcpInput(
      { disabled: true },
      { requireConnection: false },
    );
    expect(input).toEqual({ disabled: true });
  });

  test("a bundle makes a hosted server; url and bundle never mix", async () => {
    const hosted = await normalizeMcpInput(
      { name: "hosted", bundle: "export default () => new Response()" },
      { requireConnection: true },
    );
    expect(hosted.transport).toBe("hosted");
    expect(hosted.url).toBeUndefined();
    expect(hosted.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      normalizeMcpInput(
        { name: "both", url: SERVER_URL, bundle: "export default 1" },
        { requireConnection: true },
      ),
    ).rejects.toThrow("url, bundle and bundleStorageId are mutually exclusive");
    await expect(
      normalizeMcpInput({ name: "neither" }, { requireConnection: true }),
    ).rejects.toThrow("url must be provided, or bundle for a hosted server");
  });

  test("a bundleStorageId makes a hosted server and requires its sha256", async () => {
    const sha = "a".repeat(64);
    const input = await normalizeMcpInput(
      { name: "big", bundleStorageId: "st_123", sha256: sha },
      { requireConnection: true },
    );
    expect(input.transport).toBe("hosted");
    expect(input.bundleStorageId).toBe("st_123");
    expect(input.sha256).toBe(sha);
    await expect(
      normalizeMcpInput(
        { name: "big", bundleStorageId: "st_123" },
        { requireConnection: true },
      ),
    ).rejects.toThrow("bundleStorageId needs sha256");
    await expect(
      normalizeMcpInput(
        { name: "big", bundleStorageId: "st_123", sha256: "not-hex" },
        { requireConnection: true },
      ),
    ).rejects.toThrow("bundleStorageId needs sha256");
    await expect(
      normalizeMcpInput(
        {
          name: "both",
          bundle: "export default 1",
          bundleStorageId: "st_123",
          sha256: sha,
        },
        { requireConnection: true },
      ),
    ).rejects.toThrow("url, bundle and bundleStorageId are mutually exclusive");
  });
});

describe("hosted rows", () => {
  test("create enforces the per-transport connection fields", async () => {
    const tt = t();
    const scope = await seedScope(tt);

    await expect(
      tt.mutation(internal.account.mcp.create, {
        accountId: scope.accountId,
        projectId: scope.projectId,
        stageId: scope.stageId,
        name: "hosted",
        transport: "hosted",
      }),
    ).rejects.toThrow("hosted MCP servers need bundleStorageKey and sha256");

    const serverId = await tt.mutation(internal.account.mcp.create, {
      accountId: scope.accountId,
      projectId: scope.projectId,
      stageId: scope.stageId,
      name: "hosted",
      transport: "hosted",
      bundleStorageKey: "account-mcp/acct/bundles/x.mjs",
      sha256: "a".repeat(64),
    });
    const listed = await tt.query(internal.account.mcp.listForStage, {
      stageId: scope.stageId,
    });
    expect(listed[0]?._id).toBe(serverId);
    expect(listed[0]?.transport).toBe("hosted");
    expect(listed[0]?.url).toBeUndefined();
  });
});
