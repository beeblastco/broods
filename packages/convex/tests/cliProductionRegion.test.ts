/// <reference types="vite/client" />
import workosTest from "@convex-dev/workos-authkit/test";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { DeploymentRegion } from "../cli/types";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const regionTest = (): TestConvex<typeof schema> => convexTest(schema, modules);

type T = ReturnType<typeof regionTest>;

const SECRET_HASH = "hash-region";

async function seedAccount(t: T): Promise<void> {
  await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "region",
      slug: "region",
      ownerAuthId: "auth_owner",
      plan: "free" as const,
      createdAt: Date.now(),
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "region",
      secretHash: SECRET_HASH,
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

/** One manifest PUT: claim the scope, sync the manifest, release the claim. */
async function deploy(
  t: T,
  stage: string,
  region?: DeploymentRegion,
): Promise<Doc<"stages">> {
  const target = {
    project: "gdpr-app",
    stage: stage,
    ...(region ? { region: region } : {}),
  };
  const scope = await t.mutation(internal.cli.sync.ensureScopeBySecretHash, {
    secretHash: SECRET_HASH,
    ...target,
  });
  await t.mutation(internal.cli.sync.syncManifestBySecretHash, {
    secretHash: SECRET_HASH,
    manifest: { version: 1, ...target, resources: [] },
  });
  await t.mutation(internal.cli.sync.finishManifestSync, {
    stageId: scope.stageId,
    revision: scope.revision,
  });

  return await stageOf(t, scope.stageId);
}

async function stageOf(t: T, stageId: Id<"stages">): Promise<Doc<"stages">> {
  const stageDoc = await t.run(async (ctx) => await ctx.db.get(stageId));
  if (!stageDoc) throw new Error("stage missing");

  return stageDoc;
}

describe("production region on an automated deploy", () => {
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("the first deploy pins the region it names", async () => {
    const t = regionTest();
    await seedAccount(t);

    const production = await deploy(t, "production", "eu-west-1");

    expect(production.kind).toBe("production");
    expect(production.deploymentRegion).toBe("eu-west-1");
  });

  test("a first deploy that names no region lands in eu-west-1", async () => {
    const t = regionTest();
    await seedAccount(t);

    expect((await deploy(t, "production")).deploymentRegion).toBe("eu-west-1");
  });

  test("a later deploy cannot move Production to another region", async () => {
    const t = regionTest();
    await seedAccount(t);
    await t.mutation(internal.cli.sync.setEnvBySecretHash, {
      secretHash: SECRET_HASH,
      project: "gdpr-app",
      stage: "production",
      name: "API_KEY",
      value: "x",
    });
    // env set creates Production without a region; the deploy pins it.
    await deploy(t, "production", "eu-west-1");

    await expect(deploy(t, "production", "us-east-1")).rejects.toThrow(
      /already runs in eu-west-1/,
    );
    expect((await deploy(t, "production")).deploymentRegion).toBe("eu-west-1");
  });

  test("a region that is not live yet is refused", async () => {
    const t = regionTest();
    await seedAccount(t);

    await expect(deploy(t, "production", "us-east-1")).rejects.toThrow(
      /not available yet/,
    );
  });

  test("only Production takes a region", async () => {
    const t = regionTest();
    await seedAccount(t);

    await expect(deploy(t, "development", "eu-west-1")).rejects.toThrow(
      /only to the production stage/,
    );
    expect((await deploy(t, "development")).deploymentRegion).toBeUndefined();
  });

  test("a deploy refused after its scope claim pins nothing", async () => {
    const t = regionTest();
    await seedAccount(t);

    // The manifest action fails before its sync: only the claim ran.
    const scope = await t.mutation(internal.cli.sync.ensureScopeBySecretHash, {
      secretHash: SECRET_HASH,
      project: "gdpr-app",
      stage: "production",
      region: "eu-west-1",
    });

    expect((await stageOf(t, scope.stageId)).deploymentRegion).toBeUndefined();
  });

  test("a stage named production stored as custom is fixed and pinned", async () => {
    const t = regionTest();
    await seedAccount(t);
    const legacy = await deploy(t, "legacy");
    await t.run(async (ctx) => {
      await ctx.db.patch(legacy._id, { name: "production", kind: "custom" });
    });

    const production = await deploy(t, "Production", "eu-west-1");

    expect(production._id).toBe(legacy._id);
    expect(production.kind).toBe("production");
    expect(production.deploymentRegion).toBe("eu-west-1");
  });
});

// Initialize Production in the dashboard and an automated deploy pin the same
// field, so either one's region holds against the other.
describe("production region across the dashboard and a deploy", () => {
  const AUTH_ID = "user_region_owner";

  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** An owner signed in to the dashboard, with an org account for the CLI. */
  async function setup(): Promise<{
    t: T;
    caller: ReturnType<T["withIdentity"]>;
  }> {
    const t = regionTest();
    workosTest.register(t);
    const now = new Date().toISOString();
    await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
      apiKey: "sk_test_fixture",
      event: {
        id: "evt_region_owner",
        event: "user.created",
        createdAt: now,
        data: {
          id: AUTH_ID,
          email: "region-owner@example.invalid",
          emailVerified: true,
          metadata: {},
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("users", {
        authId: AUTH_ID,
        email: "region-owner@example.invalid",
        name: "Region owner",
        plan: "free",
      });
    });
    const caller = t.withIdentity({ subject: AUTH_ID });
    const orgId = await caller.mutation(api.org.orgs.create, {
      name: "Region fixture",
    });
    await t.mutation(internal.account.accounts.create, {
      orgId: orgId,
      username: "region-fixture",
      secretHash: SECRET_HASH,
    });

    return { t: t, caller: caller };
  }

  async function initialize(
    t: T,
    caller: ReturnType<T["withIdentity"]>,
    region: DeploymentRegion,
  ): Promise<Doc<"stages">> {
    const development = await deploy(t, "development");
    const productionId = await caller.mutation(api.stage.initializeProduction, {
      projectId: development.projectId,
      sourceStageId: development._id,
      deploymentRegion: region,
    });

    return await stageOf(t, productionId);
  }

  test("a deploy keeps the region Initialize Production chose", async () => {
    const { t, caller } = await setup();
    await initialize(t, caller, "eu-west-1");

    expect((await deploy(t, "production")).deploymentRegion).toBe("eu-west-1");
    await expect(deploy(t, "production", "us-east-1")).rejects.toThrow(
      /already runs in eu-west-1/,
    );
  });

  test("Initialize Production keeps a region a deploy pinned", async () => {
    const { t, caller } = await setup();
    const production = await deploy(t, "production");
    // A region pinned before only Europe was live.
    await t.run(async (ctx) => {
      await ctx.db.patch(production._id, { deploymentRegion: "us-east-1" });
    });

    const initialized = await initialize(t, caller, "eu-west-1");

    expect(initialized._id).toBe(production._id);
    expect(initialized.deploymentRegion).toBe("us-east-1");
  });

  test("Initialize Production refuses a region that is not live", async () => {
    const { t, caller } = await setup();

    await expect(initialize(t, caller, "ap-southeast-1")).rejects.toThrow(
      /not available yet/,
    );
  });
});
