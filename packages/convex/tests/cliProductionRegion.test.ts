/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
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

/** One manifest PUT's scope claim, then its release, as a finished deploy. */
async function deploy(
  t: T,
  stage: string,
  region?: "ap-southeast-1" | "eu-west-1" | "us-east-1",
): Promise<Doc<"stages">> {
  const scope = await t.mutation(internal.cli.sync.ensureScopeBySecretHash, {
    secretHash: SECRET_HASH,
    project: "gdpr-app",
    stage: stage,
    ...(region ? { region: region } : {}),
  });
  await t.mutation(internal.cli.sync.finishManifestSync, {
    stageId: scope.stageId,
    revision: scope.revision,
  });
  const stageDoc = await t.run(async (ctx) => await ctx.db.get(scope.stageId));
  if (!stageDoc) throw new Error("stage missing");

  return stageDoc;
}

describe("production region on an automated deploy", () => {
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
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
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
});
