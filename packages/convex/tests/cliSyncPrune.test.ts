/// <reference types="vite/client" />
/**
 * A CLI prune or delete must name the sandbox configs and workspaces it is
 * about to drop before it drops them: the HTTP layer terminates their reserved
 * instances through core in between, and core needs the config row for that.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const PROJECT = "prune";
const STAGE = "development";
const SECRET_HASH = "hash-prune";

const keepSandbox = { kind: "sandbox" as const, name: "keep", config: {} };

type Seeded = {
  dropSandboxId: Id<"sandboxConfigs">;
  keepSandboxId: Id<"sandboxConfigs">;
  manualSandboxId: Id<"sandboxConfigs">;
  workspaceId: Id<"workspaceConfigs">;
};

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

/**
 * Seeds the account, syncs an empty manifest so the project and stage exist,
 * then writes two CLI-managed sandbox configs, one dashboard-managed sandbox
 * config and one CLI-managed workspace straight into the stage.
 */
async function seedStage(tt: T): Promise<Seeded> {
  await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner@example.com",
      plan: "free" as const,
      createdAt: now,
    });
    const userId = await ctx.db.insert("users", {
      authId: "auth_owner@example.com",
      email: "owner@example.com",
      name: "Owner",
      plan: "free" as const,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "owner" as const,
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast-dev",
      secretHash: SECRET_HASH,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  });
  await tt.mutation(internal.cli.sync.syncManifestBySecretHash, {
    secretHash: SECRET_HASH,
    manifest: { version: 1, project: PROJECT, stage: STAGE, resources: [] },
  });

  return await tt.run(async (ctx) => {
    const account = await ctx.db.query("accounts").unique();
    const project = await ctx.db.query("projects").unique();
    const stage = await ctx.db.query("stages").unique();
    if (!account || !project || !stage) throw new Error("stage not synced");
    const now = Date.now();
    const sandbox = async (
      name: string,
      managedBy: "cli" | "dashboard",
    ): Promise<Id<"sandboxConfigs">> =>
      await ctx.db.insert("sandboxConfigs", {
        accountId: account._id,
        projectId: project._id,
        stageId: stage._id,
        name: name,
        managedBy: managedBy,
        createdAt: now,
        updatedAt: now,
      });

    return {
      dropSandboxId: await sandbox("drop", "cli"),
      keepSandboxId: await sandbox("keep", "cli"),
      manualSandboxId: await sandbox("manual", "dashboard"),
      workspaceId: await ctx.db.insert("workspaceConfigs", {
        accountId: account._id,
        projectId: project._id,
        stageId: stage._id,
        name: "ws",
        config: {},
        managedBy: "cli",
        createdAt: now,
        updatedAt: now,
      }),
    };
  });
}

const targets = (
  tt: T,
  target:
    | { resources: (typeof keepSandbox)[] }
    | { kind: "workspace" | "sandbox"; name: string },
) =>
  tt.query(internal.cli.sync.deleteTargetsBySecretHash, {
    secretHash: SECRET_HASH,
    project: PROJECT,
    stage: STAGE,
    target: target,
  });

const remainingNames = async (tt: T): Promise<string[]> =>
  await tt.run(async (ctx) => {
    const sandboxes = await ctx.db.query("sandboxConfigs").collect();
    const workspaces = await ctx.db.query("workspaceConfigs").collect();

    return [...sandboxes, ...workspaces].map((row) => row.name).sort();
  });

describe("cli prune and delete name their sandbox and workspace rows first", () => {
  // The sync reads stage env values, which are stored encrypted.
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("a prune names the undeclared CLI rows and nothing else", async () => {
    const tt = t();
    const seeded = await seedStage(tt);

    expect(await targets(tt, { resources: [keepSandbox] })).toEqual({
      sandboxConfigIds: [seeded.dropSandboxId],
      workspaceIds: [seeded.workspaceId],
    });
  });

  test("a single delete names its row unless the dashboard owns it", async () => {
    const tt = t();
    const seeded = await seedStage(tt);

    expect(await targets(tt, { kind: "sandbox", name: "drop" })).toEqual({
      sandboxConfigIds: [seeded.dropSandboxId],
      workspaceIds: [],
    });
    expect(await targets(tt, { kind: "workspace", name: "ws" })).toEqual({
      sandboxConfigIds: [],
      workspaceIds: [seeded.workspaceId],
    });
    expect(await targets(tt, { kind: "sandbox", name: "manual" })).toEqual({
      sandboxConfigIds: [],
      workspaceIds: [],
    });
  });

  test("the prune mutation deletes exactly what the query named", async () => {
    const tt = t();
    await seedStage(tt);

    await tt.mutation(internal.cli.sync.pruneManifestBySecretHash, {
      secretHash: SECRET_HASH,
      manifest: {
        version: 1,
        project: PROJECT,
        stage: STAGE,
        resources: [keepSandbox],
      },
    });

    expect(await remainingNames(tt)).toEqual(["keep", "manual"]);
  });
});
