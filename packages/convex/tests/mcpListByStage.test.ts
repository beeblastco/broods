/// <reference types="vite/client" />
/** The canvas reads every MCP server a stage's nodes own in one query. */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const OWNER_AUTH_ID = "auth_owner";

// The query reads its caller through the WorkOS component, which the test
// runtime does not register. The org owner is the caller here.
vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: OWNER_AUTH_ID }) },
}));

const modules = import.meta.glob("../**/*.ts");

const listTest = (): ReturnType<typeof convexTest> =>
  convexTest(schema, modules);

type T = ReturnType<typeof listTest>;

type Seeded = {
  otherStageId: Id<"stages">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
};

type ServerRow = {
  deleted?: boolean;
  disabled?: boolean;
  name: string;
  nodeId?: string;
  sandbox?: string;
  stageId: Id<"stages">;
  transport: "http" | "hosted" | "machine";
};

describe("mcp.listByStage", () => {
  test("lists the active servers canvas nodes own in that stage only", async () => {
    const t = listTest();
    const { otherStageId, projectId, stageId } = await seed(t);
    await insertServers(t, projectId, [
      {
        name: "github",
        nodeId: "node_github",
        stageId: stageId,
        transport: "http",
      },
      {
        disabled: true,
        name: "blender",
        nodeId: "node_blender",
        sandbox: "kien-mac",
        stageId: stageId,
        transport: "machine",
      },
      // A CLI row has no canvas node, a deleted row is gone, and another
      // stage's row belongs to another canvas.
      { name: "search", stageId: stageId, transport: "hosted" },
      {
        deleted: true,
        name: "old",
        nodeId: "node_old",
        stageId: stageId,
        transport: "http",
      },
      {
        name: "linear",
        nodeId: "node_linear",
        stageId: otherStageId,
        transport: "http",
      },
    ]);

    const servers = await t.query(api.mcp.listByStage, {
      projectId: projectId,
      stageId: stageId,
    });

    expect([...servers].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      {
        nodeId: "node_blender",
        name: "blender",
        transport: "machine",
        sandbox: "kien-mac",
        disabled: true,
      },
      {
        nodeId: "node_github",
        name: "github",
        transport: "http",
        sandbox: null,
        disabled: false,
      },
    ]);
  });

  test("returns nothing for a stage outside the project", async () => {
    const t = listTest();
    const { stageId } = await seed(t);
    const { projectId: otherProjectId } = await seed(t);
    await insertServers(t, otherProjectId, [
      {
        name: "github",
        nodeId: "node_github",
        stageId: stageId,
        transport: "http",
      },
    ]);

    expect(
      await t.query(api.mcp.listByStage, {
        projectId: otherProjectId,
        stageId: stageId,
      }),
    ).toEqual([]);
  });
});

async function insertServers(
  t: T,
  projectId: Id<"projects">,
  rows: readonly ServerRow[],
): Promise<void> {
  await t.run(async (ctx) => {
    const project = await ctx.db.get(projectId);
    const account = await ctx.db
      .query("accounts")
      .filter((q) => q.eq(q.field("orgId"), project?.orgId))
      .first();
    if (!account) throw new Error("seed has no account");
    const now = Date.now();
    for (const row of rows) {
      await ctx.db.insert("mcp", {
        accountId: account._id,
        projectId: projectId,
        stageId: row.stageId,
        name: row.name,
        transport: row.transport,
        ...(row.transport === "http"
          ? { url: "https://mcp.example.com/mcp" }
          : {}),
        ...(row.sandbox ? { sandbox: row.sandbox } : {}),
        ...(row.disabled ? { disabled: true } : {}),
        ...(row.nodeId ? { nodeId: row.nodeId } : {}),
        status: row.deleted ? ("deleted" as const) : ("active" as const),
        createdAt: now,
        updatedAt: now,
      });
    }
  });
}

/** An org its owner can read, one project, and two of its stages. */
async function seed(t: T): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: `beeblast-${now}-${Math.random()}`,
      ownerAuthId: OWNER_AUTH_ID,
      plan: "free" as const,
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: `hash-${now}-${Math.random()}`,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: OWNER_AUTH_ID,
      orgId: orgId,
      name: "tracy",
      slug: "tracy",
      updatedAt: now,
    });
    const stage = async (
      name: string,
      isDefault: boolean,
    ): Promise<Id<"stages">> =>
      await ctx.db.insert("stages", {
        authId: OWNER_AUTH_ID,
        projectId: projectId,
        name: name,
        kind: "development" as const,
        isDefault: isDefault,
        updatedAt: now,
      });
    const stageId = await stage("development", true);
    const otherStageId = await stage("preview", false);

    return {
      otherStageId: otherStageId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}
