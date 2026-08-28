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
    headers: { Authorization: 'Bearer env("SEARCH_TOKEN")' },
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
  test("accepts a full registration", () => {
    const input = normalizeMcpInput(
      {
        name: "search",
        description: "Company search backend.",
        url: SERVER_URL,
        headers: { Authorization: 'Bearer env("SEARCH_TOKEN")' },
        allowedTools: ["query", "fetch_doc"],
      },
      { requireConnection: true },
    );
    expect(input.name).toBe("search");
    expect(input.allowedTools).toEqual(["query", "fetch_doc"]);
  });

  test("requires name and url on create", () => {
    expect(() =>
      normalizeMcpInput({ url: SERVER_URL }, { requireConnection: true }),
    ).toThrow("name must be provided");
    expect(() =>
      normalizeMcpInput({ name: "search" }, { requireConnection: true }),
    ).toThrow("url must be provided");
  });

  test("rejects names that break the server__tool namespace", () => {
    for (const name of ["Search", "se_arch", "1search", "a".repeat(33), ""]) {
      expect(() =>
        normalizeMcpInput(
          { name: name, url: SERVER_URL },
          { requireConnection: true },
        ),
      ).toThrow("name must be");
    }
  });

  test("rejects non-http urls and header injection", () => {
    expect(() =>
      normalizeMcpInput(
        { name: "search", url: "ftp://mcp.example.com" },
        { requireConnection: true },
      ),
    ).toThrow("url must use http or https");
    expect(() =>
      normalizeMcpInput(
        { name: "search", url: "not a url" },
        { requireConnection: true },
      ),
    ).toThrow("url must be a valid absolute URL");
    expect(() =>
      normalizeMcpInput(
        {
          name: "search",
          url: SERVER_URL,
          headers: { Authorization: "Bearer x\r\nHost: evil" },
        },
        { requireConnection: true },
      ),
    ).toThrow("headers values must be single-line");
  });

  test("a patch may carry any subset", () => {
    const input = normalizeMcpInput(
      { disabled: true },
      { requireConnection: false },
    );
    expect(input).toEqual({ disabled: true });
  });
});
