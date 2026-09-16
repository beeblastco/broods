/// <reference types="vite/client" />
/** A canvas save writes each dashboard agent's sandboxes and workspaces. */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const OWNER_AUTH_ID = "auth_owner";

// The mutation reads its caller through the WorkOS component, which the test
// runtime does not register. The org owner is the caller here.
vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: OWNER_AUTH_ID }) },
}));

const modules = import.meta.glob("../**/*.ts");

const refsTest = () => convexTest(schema, modules);

type T = ReturnType<typeof refsTest>;

type Seeded = {
  configId: Id<"agentConfigs">;
  keptSandboxId: Id<"sandboxConfigs">;
  prunedSandboxId: Id<"sandboxConfigs">;
};

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
      configId: configId,
      keptSandboxId: keptSandboxId,
      prunedSandboxId: prunedSandboxId,
    };
  });
}
