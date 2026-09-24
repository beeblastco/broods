/// <reference types="vite/client" />
/**
 * A CLI prune removes the skills, hooks and MCP servers its own stage recorded,
 * even when the manifest now declares none, and never one another stage
 * records or the dashboard created. A pruned agent takes its crons along.
 */

import cronsComponent from "@convex-dev/crons/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const { deleteSkill } = vi.hoisted(() => ({
  deleteSkill: vi.fn(async (): Promise<number> => 1),
}));

vi.mock("../model/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model/skills")>()),
  deleteSkill: deleteSkill,
}));

const modules = import.meta.glob("../**/*.ts");

const PROJECT = "prune-external";
const SECRET = "fp_secret_prune_external";
const STAGE = "development";
const OTHER_STAGE = "production";

type T = TestConvex<typeof schema>;

const t = (): T => {
  const tt = convexTest(schema, modules);
  cronsComponent.register(tt);

  return tt;
};

describe("cli prune of external resources", () => {
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    deleteSkill.mockClear();
  });

  test("removes this stage's last hook and MCP server, keeps other owners'", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    await recordHook(tt, accountId, STAGE, "mine");
    await recordHook(tt, accountId, OTHER_STAGE, "theirs");
    await insertHook(tt, accountId, "dashboard");
    await recordMcpServer(tt, accountId, "search");
    await insertMcpServer(tt, accountId, "dashboard-search");

    expect((await pruneAll(tt)).status).toBe(200);
    expect(await activeNames(tt)).toEqual({
      hooks: ["dashboard", "theirs"],
      mcp: ["dashboard-search"],
      recorded: ["production:hook:theirs"],
    });
  });

  test("removes this stage's skills and their files, keeps another stage's", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    await recordSkill(tt, STAGE, "mine");
    await recordSkill(tt, OTHER_STAGE, "theirs");

    expect((await pruneAll(tt)).status).toBe(200);
    expect(deleteSkill.mock.calls).toEqual([[accountId, "mine"]]);
    expect(
      await tt.run(
        async (ctx) => await ctx.db.query("workspaceFiles").collect(),
      ),
    ).toEqual([expect.objectContaining({ path: "theirs/SKILL.md" })]);
  });

  test("a pruned agent's crons go with it", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const secretHash = await sha256Hex(SECRET);
    const synced = await tt.mutation(
      internal.cli.sync.syncManifestBySecretHash,
      {
        secretHash: secretHash,
        manifest: {
          version: 1,
          project: PROJECT,
          stage: STAGE,
          resources: [
            {
              kind: "agent",
              name: "reporter",
              config: {
                model: { provider: "custom", modelId: "Qwen3.6-27B" },
                agent: { system: "Write the report." },
              },
            },
          ],
        },
      },
    );
    const agentId = synced.ids.agents?.reporter;
    if (!agentId) throw new Error("agent not synced");
    await tt.mutation(internal.agent.crons.create, {
      accountId: accountId,
      input: {
        name: "hourly",
        agentId: agentId,
        input: "run the report",
        scheduleExpression: "rate(1 hour)",
      },
    });

    await tt.mutation(internal.cli.sync.syncManifestBySecretHash, {
      secretHash: secretHash,
      manifest: { version: 1, project: PROJECT, stage: STAGE, resources: [] },
      prune: true,
    });

    expect(
      await tt.run(async (ctx) => await ctx.db.query("crons").collect()),
    ).toEqual([]);
  });
});

/** Active hook and MCP names, and every recorded external resource by stage kind. */
async function activeNames(
  tt: T,
): Promise<{ hooks: string[]; mcp: string[]; recorded: string[] }> {
  return await tt.run(async (ctx) => {
    const hooks = await ctx.db.query("accountHooks").collect();
    const servers = await ctx.db.query("mcp").collect();
    const recorded = await ctx.db.query("cliExternalResources").collect();
    const stages = await ctx.db.query("stages").collect();
    const stageNames = new Map(
      stages.map((stage): [string, string] => [stage._id, stage.kind]),
    );

    return {
      hooks: hooks
        .filter((row) => row.status === "active")
        .map((row): string => row.name)
        .sort(),
      mcp: servers
        .filter((row) => row.status === "active")
        .map((row): string => row.name)
        .sort(),
      recorded: recorded
        .map(
          (row): string =>
            `${stageNames.get(row.stageId)}:${row.kind}:${row.name}`,
        )
        .sort(),
    };
  });
}

async function insertHook(
  tt: T,
  accountId: Id<"accounts">,
  name: string,
): Promise<Id<"accountHooks">> {
  return await tt.run(async (ctx) => {
    const now = Date.now();

    return await ctx.db.insert("accountHooks", {
      accountId: accountId,
      name: name,
      events: ["agent.finished"],
      bundleStorageKey: `hooks/${name}.mjs`,
      sha256: name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** A stage MCP server nothing recorded, as the dashboard or config API makes one. */
async function insertMcpServer(
  tt: T,
  accountId: Id<"accounts">,
  name: string,
): Promise<Id<"mcp">> {
  const scope = await tt.mutation(internal.cli.sync.ensureScopeBySecretHash, {
    secretHash: await sha256Hex(SECRET),
    project: PROJECT,
    stage: STAGE,
  });

  return await tt.mutation(internal.account.mcp.create, {
    accountId: accountId,
    projectId: scope.projectId,
    stageId: scope.stageId,
    name: name,
    url: "https://mcp.example.com/mcp",
  });
}

/** `deploy --prune` of an empty manifest to the development stage. */
async function pruneAll(tt: T): Promise<Response> {
  return await tt.fetch(
    `/v1/account/projects/${PROJECT}/stages/${STAGE}/manifest`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        manifest: { version: 1, project: PROJECT, stage: STAGE, resources: [] },
        prune: true,
      }),
    },
  );
}

/** An account hook that `stage` recorded as CLI-managed. */
async function recordHook(
  tt: T,
  accountId: Id<"accounts">,
  stage: string,
  name: string,
): Promise<void> {
  const hookId = await insertHook(tt, accountId, name);
  await tt.mutation(internal.cli.sync.recordExternalResourcesBySecretHash, {
    secretHash: await sha256Hex(SECRET),
    project: PROJECT,
    stage: stage,
    resources: [
      { kind: "hook", name: name, config: { events: ["agent.finished"] } },
    ],
    ids: { skills: {}, hooks: { [name]: hookId }, mcp: {} },
  });
}

/** A skill `stage` recorded as CLI-managed, with the file `syncSkillNodeFiles` mirrors. */
async function recordSkill(tt: T, stage: string, name: string): Promise<void> {
  const secretHash = await sha256Hex(SECRET);
  await tt.mutation(internal.cli.sync.ensureScopeBySecretHash, {
    secretHash: secretHash,
    project: PROJECT,
    stage: stage,
  });
  const storageId = await tt.run(
    async (ctx) => await ctx.storage.store(new Blob(["# skill"])),
  );
  await tt.mutation(internal.cli.sync.replaceSkillNodeFilesBySecretHash, {
    secretHash: secretHash,
    project: PROJECT,
    stage: stage,
    skillName: name,
    files: [
      { path: `${name}/SKILL.md`, name: "SKILL.md", storageId: storageId },
    ],
  });
  await tt.mutation(internal.cli.sync.recordExternalResourcesBySecretHash, {
    secretHash: secretHash,
    project: PROJECT,
    stage: stage,
    resources: [{ kind: "skill", name: name, config: { files: [] } }],
    ids: { skills: { [name]: `skills/${name}` }, hooks: {}, mcp: {} },
  });
}

/** A stage MCP server that the development stage recorded as CLI-managed. */
async function recordMcpServer(
  tt: T,
  accountId: Id<"accounts">,
  name: string,
): Promise<void> {
  const secretHash = await sha256Hex(SECRET);
  const scope = await tt.mutation(internal.cli.sync.ensureScopeBySecretHash, {
    secretHash: secretHash,
    project: PROJECT,
    stage: STAGE,
  });
  const serverId = await tt.mutation(internal.account.mcp.create, {
    accountId: accountId,
    projectId: scope.projectId,
    stageId: scope.stageId,
    name: name,
    url: "https://mcp.example.com/mcp",
  });
  await tt.mutation(internal.cli.sync.recordExternalResourcesBySecretHash, {
    secretHash: secretHash,
    project: PROJECT,
    stage: STAGE,
    resources: [
      {
        kind: "mcp",
        name: name,
        config: { url: "https://mcp.example.com/mcp" },
      },
    ],
    ids: { skills: {}, hooks: {}, mcp: { [name]: serverId } },
  });
}

async function seedAccount(tt: T): Promise<Id<"accounts">> {
  const secretHash = await sha256Hex(SECRET);

  return await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const userId = await ctx.db.insert("users", {
      authId: "auth_owner",
      email: "owner@example.com",
      name: "Owner",
      plan: "free",
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "owner",
      createdAt: now,
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast-dev",
      secretHash: secretHash,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}
