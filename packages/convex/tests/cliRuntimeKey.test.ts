/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const runtimeKeyTest = () => convexTest(schema, modules);

type T = ReturnType<typeof runtimeKeyTest>;

const AUTH_ID = "auth_owner";
const SECRET_HASH = "hash-beeblast";

async function seed(t: T) {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: Date.now(),
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: SECRET_HASH,
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: Date.now(),
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Production",
      kind: "production" as const,
      isDefault: false,
      updatedAt: Date.now(),
    });

    return {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// These three functions are the CLI/core wire for a stage's runtime key. Their
// `returns` validators are runtime-only, so a key renamed on one side alone is
// invisible to `bun run check` and only fails when the function runs.
describe("stage runtime key wire", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("ensureScopeBySecretHash resolves the project and stage ids", async () => {
    const t = runtimeKeyTest();
    const seeded = await seed(t);

    const scope = await t.mutation(internal.cli.sync.ensureScopeBySecretHash, {
      secretHash: SECRET_HASH,
      project: "demo-app",
      stage: "production",
    });

    expect(scope).toEqual({
      projectId: seeded.projectId,
      stageId: seeded.stageId,
    });
  });

  test("ensureRuntimeKeyBySecretHash returns a stage-scoped endpoint and slug", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const t = runtimeKeyTest();
    const seeded = await seed(t);

    const deployment = await t.mutation(
      internal.cli.sync.ensureRuntimeKeyBySecretHash,
      {
        secretHash: SECRET_HASH,
        project: "demo-app",
        stage: "production",
      },
    );

    expect(deployment).not.toBeNull();
    expect(Object.keys(deployment!).sort()).toEqual([
      "accountId",
      "apiKey",
      "endpointId",
      "keyHint",
      "projectSlug",
      "stageKind",
      "stageSlug",
    ]);
    expect(deployment!.stageSlug).toBe("production");
    expect(deployment!.projectSlug).toBe("demo-app");
    expect(deployment!.endpointId).toBe(`stage-${seeded.stageId.slice(-8)}`);
  });

  test("getByApiKeyHash hands core the same stage slug", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const t = runtimeKeyTest();
    const seeded = await seed(t);

    const deployment = await t.mutation(
      internal.cli.sync.ensureRuntimeKeyBySecretHash,
      {
        secretHash: SECRET_HASH,
        project: "demo-app",
        stage: "production",
      },
    );
    const scope = await t.query(internal.agent.deployments.getByApiKeyHash, {
      apiKeyHash: await sha256Hex(deployment!.apiKey),
    });

    expect(scope).toEqual({
      accountId: seeded.accountId,
      projectId: seeded.projectId,
      stageId: seeded.stageId,
      endpointId: `stage-${seeded.stageId.slice(-8)}`,
      projectSlug: "demo-app",
      stageSlug: "production",
    });
  });
});
