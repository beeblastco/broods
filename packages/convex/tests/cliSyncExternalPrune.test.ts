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
import type { CliManifestResource } from "../cli/types";
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

  test("keeps a hook the dashboard recreated under a name this stage recorded", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    await recordHook(tt, accountId, STAGE, "notify");
    await tt.run(async (ctx) => {
      const recorded = await ctx.db.query("accountHooks").first();
      await ctx.db.patch(recorded!._id, { status: "deleted" });
    });
    await insertHook(tt, accountId, "notify");

    expect((await pruneAll(tt)).status).toBe(200);
    expect((await activeNames(tt)).hooks).toEqual(["notify"]);
  });

  test("a deploy the manifest sync rejects removes nothing", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    await recordHook(tt, accountId, STAGE, "mine");
    await recordMcpServer(tt, accountId, "search");
    const before = await activeNames(tt);

    const response = await pruneAll(tt, [
      {
        kind: "agent",
        name: "support",
        config: { instructions: { __beeblastEnv: true, name: "UNSET_VALUE" } },
      },
    ]);

    expect(response.status).toBe(400);
    expect(await activeNames(tt)).toEqual(before);
  });

  test("a manifest the sync rejects uploads no MCP server first", async () => {
    const tt = t();
    await seedAccount(tt);
    const before = await activeNames(tt);

    const response = await pruneAll(tt, [
      {
        kind: "mcp",
        name: "search",
        config: { transport: "http", url: "https://mcp.example.com/mcp" },
      },
      {
        kind: "agent",
        name: "support",
        config: { instructions: { __beeblastEnv: true, name: "UNSET_VALUE" } },
      },
    ]);

    expect(response.status).toBe(400);
    expect(await activeNames(tt)).toEqual(before);
  });

  test("a cron naming an agent declared with padded whitespace still syncs", async () => {
    const tt = t();
    await seedAccount(tt);

    const response = await pruneAll(tt, [
      {
        kind: "agent",
        name: " reporter ",
        config: {
          model: { provider: "custom", modelId: "Qwen3.6-27B" },
          agent: { system: "Write the report." },
        },
      },
      {
        kind: "cron",
        name: "nightly",
        config: {
          agentId: "reporter",
          events: [{ role: "user", content: "Write the report." }],
          scheduleExpression: "rate(1 day)",
        },
      },
    ]);

    expect(response.status).toBe(200);
  });

  test("a cron naming an unknown agent is refused before anything syncs", async () => {
    const tt = t();
    await seedAccount(tt);

    const response = await pruneAll(tt, [
      {
        kind: "mcp",
        name: "search",
        config: { transport: "http", url: "https://mcp.example.com/mcp" },
      },
      {
        kind: "cron",
        name: "nightly",
        config: {
          agentId: "missing",
          events: [{ role: "user", content: "Write the report." }],
          scheduleExpression: "rate(1 day)",
        },
      },
    ]);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unknown deployed agent: missing");
    expect(await activeNames(tt)).toEqual({ hooks: [], mcp: [], recorded: [] });
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

  test("renames a cron created under its old config.name instead of replacing it", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const agent = {
      kind: "agent" as const,
      name: "reporter",
      config: {
        model: { provider: "custom", modelId: "Qwen3.6-27B" },
        agent: { system: "Write the report." },
      },
    };
    const synced = await tt.mutation(
      internal.cli.sync.syncManifestBySecretHash,
      {
        secretHash: await sha256Hex(SECRET),
        manifest: {
          version: 1,
          project: PROJECT,
          stage: STAGE,
          resources: [agent],
        },
      },
    );
    const agentId = synced.ids.agents?.reporter;
    if (!agentId) throw new Error("agent not synced");
    await tt.mutation(internal.agent.crons.create, {
      accountId: accountId,
      input: {
        name: "Hourly report",
        agentId: agentId,
        input: "run the report",
        scheduleExpression: "rate(1 hour)",
      },
    });
    const [legacy] = await tt.query(internal.agent.crons.list, {
      accountId: accountId,
    });

    const response = await pruneAll(tt, [
      agent,
      {
        kind: "cron",
        name: "hourly",
        config: {
          agentId: "reporter",
          name: "Hourly report",
          events: [{ role: "user", content: "run the report" }],
          scheduleExpression: "rate(1 hour)",
        },
      },
    ]);

    expect(response.status).toBe(200);
    expect(
      (await tt.query(internal.agent.crons.list, { accountId: accountId })).map(
        (cron) => [cron._id, cron.name],
      ),
    ).toEqual([[legacy?._id, "hourly"]]);
  });

  test("a legacy name never takes the cron another job owns by name", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const agent = {
      kind: "agent" as const,
      name: "reporter",
      config: {
        model: { provider: "custom", modelId: "Qwen3.6-27B" },
        agent: { system: "Write the report." },
      },
    };
    const synced = await tt.mutation(
      internal.cli.sync.syncManifestBySecretHash,
      {
        secretHash: await sha256Hex(SECRET),
        manifest: {
          version: 1,
          project: PROJECT,
          stage: STAGE,
          resources: [agent],
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
    const [hourly] = await tt.query(internal.agent.crons.list, {
      accountId: accountId,
    });
    const cron = (name: string, legacyName?: string): CliManifestResource => ({
      kind: "cron",
      name: name,
      config: {
        agentId: "reporter",
        ...(legacyName ? { name: legacyName } : {}),
        events: [{ role: "user", content: "run the report" }],
        scheduleExpression: "rate(1 hour)",
      },
    });

    // The job listed first carries the other job's name as its legacy name.
    const response = await pruneAll(tt, [
      agent,
      cron("daily", "hourly"),
      cron("hourly"),
    ]);

    expect(response.status).toBe(200);
    const crons = await tt.query(internal.agent.crons.list, {
      accountId: accountId,
    });
    expect(crons.find((row) => row.name === "hourly")?._id).toBe(hourly?._id);
    expect(crons.map((row) => row.name).sort()).toEqual(["daily", "hourly"]);
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

/** An active account hook, as the dashboard makes one. */
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

/** `deploy --prune` to the development stage, of an empty manifest by default. */
async function pruneAll(
  tt: T,
  resources: Array<{ kind: string; name: string; config: unknown }> = [],
): Promise<Response> {
  return await tt.fetch(
    `/v1/account/projects/${PROJECT}/stages/${STAGE}/manifest`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        manifest: {
          version: 1,
          project: PROJECT,
          stage: STAGE,
          resources: resources,
        },
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

/** A stage MCP server that the development stage recorded as CLI-managed. */
async function recordMcpServer(
  tt: T,
  accountId: Id<"accounts">,
  name: string,
): Promise<void> {
  const serverId = await insertMcpServer(tt, accountId, name);
  await tt.mutation(internal.cli.sync.recordExternalResourcesBySecretHash, {
    secretHash: await sha256Hex(SECRET),
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

/** An org, its owner and an active account whose secret is `SECRET`. */
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
