/// <reference types="vite/client" />
/**
 * A canvas save writes each dashboard agent's sandboxes and workspaces, and a
 * config only ever reaches the `agents` row its own account owns.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

const OWNER_AUTH_ID = "auth_owner";

// The mutation reads its caller through the WorkOS component, which the test
// runtime does not register. The org owner is the caller here.
vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: OWNER_AUTH_ID }) },
}));

const modules = import.meta.glob("../**/*.ts");

const refsTest = (): ReturnType<typeof convexTest> =>
  convexTest(schema, modules);

type T = ReturnType<typeof refsTest>;

type Seeded = {
  accountId: Id<"accounts">;
  configId: Id<"agentConfigs">;
  keptSandboxId: Id<"sandboxConfigs">;
  prunedSandboxId: Id<"sandboxConfigs">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
};

describe("agent row ownership", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("update takes no agent id from the client", async () => {
    const t = refsTest();
    const { configId, foreignAgentId } = await seedForeignLink(t, "unlinked");

    await expect(
      t.mutation(api.agent.config.update, {
        configId: configId,
        // @ts-expect-error the server owns agentId, it is not a public arg
        agentId: foreignAgentId,
      }),
    ).rejects.toThrow();
    expect((await docOf(t, configId))?.agentId).toBeUndefined();
  });

  test("update syncs the account's own row", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const t = refsTest();
    const { accountId, configId } = await seedForeignLink(t, "unlinked");

    await t.mutation(api.agent.config.update, {
      configId: configId,
      name: "renamed",
    });
    const linkedId = (await docOf(t, configId))?.agentId as Id<"agents">;
    await t.mutation(api.agent.config.update, {
      configId: configId,
      description: "second save",
    });

    expect((await docOf(t, configId))?.agentId).toBe(linkedId);
    const agent = await docOf(t, linkedId);
    expect(agent).toMatchObject({
      accountId: accountId,
      name: "renamed",
      description: "second save",
    });
    expect(agent?.encryptedConfig).toBeTruthy();
  });

  test("update replaces a link to another account's row and leaves that row alone", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const t = refsTest();
    const { accountId, configId, foreignAgentId } = await seedForeignLink(
      t,
      "linked",
    );
    const before = await docOf(t, foreignAgentId);

    await t.mutation(api.agent.config.update, {
      configId: configId,
      name: "renamed",
    });

    expect(await docOf(t, foreignAgentId)).toEqual(before);
    const linkedId = (await docOf(t, configId))?.agentId as Id<"agents">;
    expect(linkedId).not.toBe(foreignAgentId);
    expect(await docOf(t, linkedId)).toMatchObject({
      accountId: accountId,
      name: "renamed",
    });
  });

  test("remove deletes the config and leaves another account's row alone", async () => {
    const t = refsTest();
    const { configId, foreignAgentId } = await seedForeignLink(t, "linked");
    const before = await docOf(t, foreignAgentId);

    await t.mutation(api.agent.config.remove, { configId: configId });

    expect(await docOf(t, configId)).toBeNull();
    expect(await docOf(t, foreignAgentId)).toEqual(before);
    // No runtime data deletion was queued for the other account's agent.
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toEqual([]);
  });

  test("the incident query lists only configs linked across accounts", async () => {
    const t = refsTest();
    const { accountId, configId, foreignAgentId } = await seedForeignLink(
      t,
      "linked",
    );

    const links = await t.query(internal.agent.agents.listForeignAgentLinks, {
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(links.page).toMatchObject([
      {
        configId: configId,
        projectAccountId: accountId,
        agentId: foreignAgentId,
      },
    ]);
    expect(links.page[0].agentAccountId).not.toBe(accountId);
  });
});

describe("updateRuntimeRefs", () => {
  test("refuses an order that puts a workspace's sandbox after the default", async () => {
    const t = refsTest();
    const { configId, keptSandboxId, prunedSandboxId } = await seed(t, []);
    const workspaces = [
      { name: "notes", workspaceId: "ws_notes", sandbox: keptSandboxId },
    ];

    await expect(
      t.mutation(api.agent.config.updateRuntimeRefs, {
        configId: configId,
        sandboxes: [prunedSandboxId, keptSandboxId],
        workspaces: workspaces,
      }),
    ).rejects.toThrow("only the first sandbox can back a workspace");
    expect(await extraConfigOf(t, configId)).toEqual({});
  });

  test("drops a stored sandbox whose row the same save deleted", async () => {
    const t = refsTest();
    const { configId, keptSandboxId, prunedSandboxId } = await seed(t, [
      "kept",
      "pruned",
    ]);
    // The layout save removed the node and deleted its dashboard row; the
    // canvas draws neither sandbox any more.
    await t.run(async (ctx) => {
      await ctx.db.delete(prunedSandboxId);
    });

    await t.mutation(api.agent.config.updateRuntimeRefs, {
      configId: configId,
      sandboxes: [],
      workspaces: null,
    });

    expect(await extraConfigOf(t, configId)).toEqual({
      sandboxes: [keptSandboxId],
    });
  });
});

async function docOf<Table extends "agentConfigs" | "agents">(
  t: T,
  id: Id<Table>,
): Promise<Doc<Table> | null> {
  return await t.run(async (ctx) => await ctx.db.get(id));
}

async function extraConfigOf(
  t: T,
  configId: Id<"agentConfigs">,
): Promise<unknown> {
  return await t.run(
    async (ctx) => (await ctx.db.get(configId))?.extraConfig ?? {},
  );
}

/**
 * An org its owner can administer, one stage with an empty canvas, two
 * sandbox rows, and a dashboard agent config storing the named ones.
 */
async function seed(
  t: T,
  stored: readonly ("kept" | "pruned")[],
): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: OWNER_AUTH_ID,
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash-beeblast",
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
    const stageId = await ctx.db.insert("stages", {
      authId: OWNER_AUTH_ID,
      projectId: projectId,
      name: "development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });
    await ctx.db.insert("canvasLayouts", {
      authId: OWNER_AUTH_ID,
      projectId: projectId,
      stageId: stageId,
      nodes: [],
      edges: [],
      updatedAt: now,
    });
    const sandbox = async (name: string): Promise<Id<"sandboxConfigs">> =>
      await ctx.db.insert("sandboxConfigs", {
        accountId: accountId,
        projectId: projectId,
        stageId: stageId,
        name: name,
        managedBy: "dashboard" as const,
        createdAt: now,
        updatedAt: now,
      });
    const keptSandboxId = await sandbox("kept");
    const prunedSandboxId = await sandbox("pruned");
    const ids = { kept: keptSandboxId, pruned: prunedSandboxId };
    // Created by someone else, so the save provisions no agent row and needs
    // no encryption secret.
    const configId = await ctx.db.insert("agentConfigs", {
      authId: "auth_creator",
      name: "tracy",
      projectId: projectId,
      stageId: stageId,
      extraConfig:
        stored.length > 0 ? { sandboxes: stored.map((key) => ids[key]) } : {},
      updatedAt: now,
    });

    return {
      accountId: accountId,
      configId: configId,
      keptSandboxId: keptSandboxId,
      prunedSandboxId: prunedSandboxId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}

/**
 * The seeded org plus a second account's `agents` row, and a config the
 * caller authored that either names that row or names none.
 */
async function seedForeignLink(
  t: T,
  link: "linked" | "unlinked",
): Promise<{
  accountId: Id<"accounts">;
  configId: Id<"agentConfigs">;
  foreignAgentId: Id<"agents">;
}> {
  const { accountId, projectId, stageId } = await seed(t, []);

  return await t.run(async (ctx) => {
    const now = Date.now();
    const foreignOrgId = await ctx.db.insert("orgs", {
      name: "other",
      slug: "other",
      ownerAuthId: "auth_other",
      plan: "free" as const,
      createdAt: now,
    });
    const foreignAccountId = await ctx.db.insert("accounts", {
      orgId: foreignOrgId,
      username: "other",
      secretHash: "hash-other",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const foreignAgentId = await ctx.db.insert("agents", {
      accountId: foreignAccountId,
      name: "theirs",
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("agentConfigs", {
      authId: OWNER_AUTH_ID,
      name: "mine",
      agentId: link === "linked" ? foreignAgentId : undefined,
      projectId: projectId,
      stageId: stageId,
      updatedAt: now,
    });

    return {
      accountId: accountId,
      configId: configId,
      foreignAgentId: foreignAgentId,
    };
  });
}
