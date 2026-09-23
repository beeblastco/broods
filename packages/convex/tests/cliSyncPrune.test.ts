/// <reference types="vite/client" />
/**
 * A CLI prune or single delete terminates the reserved instances of what it
 * drops through core while the rows still exist. A sandbox config whose
 * instance core did not remove is kept; a workspace is deleted regardless.
 */

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import { workspaceNamespace } from "../model/workspaceRules";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const CORE_URL = "https://core.test";
const PROJECT = "prune";
const SECRET = "fp_secret_prune";
const STAGE = "development";
const STAGE_PATH = `/v1/account/projects/${PROJECT}/stages/${STAGE}`;

type T = TestConvex<typeof schema>;

const t = (): T => convexTest(schema, modules);

interface Seeded {
  instanceId: Id<"sandboxInstances">;
  manualId: Id<"sandboxConfigs">;
  sandboxId: Id<"sandboxConfigs">;
}

describe("cli prune and delete terminate reserved instances first", () => {
  beforeEach(() => {
    // The sync reads stage env values, which are stored encrypted.
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    vi.stubEnv("BROODS_ACCOUNT_MANAGE_URL", CORE_URL);
    vi.stubEnv("SERVICE_AUTH_SECRET", "service-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("a delete terminates while the config exists, then drops it", async () => {
    const tt = t();
    const seeded = await seedStage(tt);
    const terminated: { url: string; configExists: boolean }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        const configExists = await tt.run(
          async (ctx): Promise<boolean> =>
            (await ctx.db.get(seeded.sandboxId)) !== null,
        );
        terminated.push({ url: url, configExists: configExists });
        // Core drops the mirror row once the terminate succeeds.
        await tt.run(async (ctx): Promise<void> => {
          await ctx.db.delete(seeded.instanceId);
        });

        return new Response("{}", { status: 200 });
      }),
    );

    const response = await deleteSandbox(tt);

    expect(response.status).toBe(200);
    expect(terminated).toEqual([
      {
        url: `${CORE_URL}/v1/sandboxes/${seeded.sandboxId}/terminate`,
        configExists: true,
      },
    ]);
    expect(await remainingNames(tt)).toEqual(["manual", "ws"]);
  });

  test("a failed terminate keeps the config and answers 409", async () => {
    const tt = t();
    await seedStage(tt);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => new Response("", { status: 502 })),
    );

    const response = await deleteSandbox(tt);
    const body: { error: { code: string } } = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("sandbox_instance_reserved");
    expect(await remainingNames(tt)).toEqual(["box", "manual", "ws"]);
  });

  test("a prune keeps a still-reserved sandbox and reports it", async () => {
    const tt = t();
    await seedStage(tt);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => new Response("", { status: 502 })),
    );

    const response = await tt.fetch(`${STAGE_PATH}/manifest`, {
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
          resources: [],
        },
        prune: true,
      }),
    });
    const body: { warnings: { reservedResources: string[] } } =
      await response.json();

    expect(response.status).toBe(200);
    expect(body.warnings.reservedResources).toEqual(['sandbox "box"']);
    expect(await remainingNames(tt)).toEqual(["box", "manual"]);
  });

  test("a workspace delete tries to terminate, then drops it anyway", async () => {
    const tt = t();
    const seeded = await seedStage(tt);
    const fetchMock = vi.fn(
      async (): Promise<Response> => new Response("", { status: 502 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await tt.fetch(`${STAGE_PATH}/resources/workspace/ws`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${SECRET}` },
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      `${CORE_URL}/v1/sandboxes/${seeded.manualId}/terminate`,
      expect.anything(),
    );
    expect(await remainingNames(tt)).toEqual(["box", "manual"]);
  });
});

async function deleteSandbox(tt: T): Promise<Response> {
  return await tt.fetch(`${STAGE_PATH}/resources/sandbox/box`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${SECRET}` },
  });
}

async function remainingNames(tt: T): Promise<string[]> {
  return await tt.run(async (ctx): Promise<string[]> => {
    const sandboxes = await ctx.db.query("sandboxConfigs").collect();
    const workspaces = await ctx.db.query("workspaceConfigs").collect();

    return [...sandboxes, ...workspaces].map((row): string => row.name).sort();
  });
}

/**
 * Seeds the account, syncs an empty manifest so the project and stage exist,
 * then writes a CLI sandbox config "box" and a CLI workspace "ws", each holding
 * a running reservation ("ws" through the dashboard config "manual").
 */
async function seedStage(tt: T): Promise<Seeded> {
  const secretHash = await sha256Hex(SECRET);
  await tt.run(async (ctx): Promise<void> => {
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
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast-dev",
      secretHash: secretHash,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
  await tt.mutation(internal.cli.sync.syncManifestBySecretHash, {
    secretHash: secretHash,
    manifest: { version: 1, project: PROJECT, stage: STAGE, resources: [] },
  });

  return await tt.run(async (ctx): Promise<Seeded> => {
    const account = await ctx.db.query("accounts").unique();
    const project = await ctx.db.query("projects").unique();
    const stage = await ctx.db.query("stages").unique();
    if (!account || !project || !stage) throw new Error("stage not synced");
    const now = Date.now();
    const scope = {
      accountId: account._id,
      projectId: project._id,
      stageId: stage._id,
      createdAt: now,
      updatedAt: now,
    };
    const sandboxId = await ctx.db.insert("sandboxConfigs", {
      ...scope,
      name: "box",
      managedBy: "cli",
    });
    const manualId = await ctx.db.insert("sandboxConfigs", {
      ...scope,
      name: "manual",
      managedBy: "dashboard",
    });
    const workspaceId = await ctx.db.insert("workspaceConfigs", {
      ...scope,
      name: "ws",
      config: {},
      managedBy: "cli",
    });
    const instanceId = await ctx.db.insert("sandboxInstances", {
      accountId: account._id,
      projectId: project._id,
      stageId: stage._id,
      provider: "sandbox",
      reservationKey: "box-reservation",
      sandboxConfigId: sandboxId,
      externalId: "sbx_box",
      name: "box",
      status: "running",
      specs: { vcpu: 1, memoryMb: 1024, storageGb: 1 },
      createdAt: now,
      lastUsedAt: now,
    });
    // A workspace reservation is keyed by its namespace, not by its config.
    const namespace = await workspaceNamespace(account._id, workspaceId);
    await ctx.db.insert("sandboxInstances", {
      accountId: account._id,
      projectId: project._id,
      stageId: stage._id,
      provider: "sandbox",
      reservationKey: `${namespace}/manual`,
      sandboxConfigId: manualId,
      externalId: "sbx_ws",
      name: "ws",
      status: "running",
      specs: { vcpu: 1, memoryMb: 1024, storageGb: 1 },
      createdAt: now,
      lastUsedAt: now,
    });

    return { instanceId: instanceId, manualId: manualId, sandboxId: sandboxId };
  });
}
