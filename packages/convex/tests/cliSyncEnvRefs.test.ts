/// <reference types="vite/client" />
/** An `env("NAME")` with no stored value must fail the sync, not warn. */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { CliManifestResource } from "../cliTypes";
import type { Id } from "../_generated/dataModel";
import { loadAgentRuntimeSecrets } from "../model/agentRuntimeSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const PROJECT = "env-refs";
const STAGE = "development";
const SECRET_HASH = "hash-env-refs";
const ENV_NAME = "DEEPSEEK_API_KEY";

const agentResource = {
  kind: "agent" as const,
  name: "env-ref-agent",
  config: {
    provider: { deepseek: { apiKey: { __beeblastEnv: true, name: ENV_NAME } } },
    model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
    agent: { system: "You are a helpful assistant." },
  },
};

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

/** Seeds the org, account and owner membership a CLI sync writes against. */
async function seedAccount(tt: T): Promise<Id<"accounts">> {
  return await tt.run(async (ctx) => {
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

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast-dev",
      secretHash: SECRET_HASH,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
  });
}

const sandboxResource = {
  kind: "sandbox" as const,
  name: "env-ref-sandbox",
  config: {
    provider: "lambda",
    size: "xsmall",
    envVars: { API_KEY: { __beeblastEnv: true, name: ENV_NAME } },
  },
};

const plainAgentResource = {
  kind: "agent" as const,
  name: agentResource.name,
  config: {
    model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
    agent: { system: "You are a helpful assistant." },
  },
};

const syncResources = (
  tt: T,
  resources: CliManifestResource[],
): Promise<unknown> =>
  tt.mutation(internal.cliSync.syncManifestBySecretHash, {
    secretHash: SECRET_HASH,
    manifest: {
      version: 1 as const,
      project: PROJECT,
      stage: STAGE,
      resources: resources,
    },
  });

const sync = (tt: T): Promise<unknown> => syncResources(tt, [agentResource]);

const setEnv = (tt: T, value: string): Promise<null> =>
  tt.mutation(internal.cliSync.setEnvBySecretHash, {
    secretHash: SECRET_HASH,
    project: PROJECT,
    stage: STAGE,
    name: ENV_NAME,
    value: value,
  });

const removeEnv = (tt: T): Promise<{ removed: boolean }> =>
  tt.mutation(internal.cliSync.removeEnvBySecretHash, {
    secretHash: SECRET_HASH,
    project: PROJECT,
    stage: STAGE,
    name: ENV_NAME,
  });

const storedEnvCount = (tt: T): Promise<number> =>
  tt.run(
    async (ctx) =>
      (await ctx.db.query("environmentVariables").collect()).length,
  );

/** What the harness actually receives: the config keeps `${NAME}`, the value
 * rides along in the agent's encrypted runtime variables. */
const runtimeValue = (tt: T): Promise<string | undefined> =>
  tt.run(async (ctx) => {
    const config = await ctx.db.query("agentConfigs").first();
    if (!config) throw new Error("Agent config was not synced");

    return (await loadAgentRuntimeSecrets(ctx, config._id))[ENV_NAME];
  });

const rowCounts = async (
  tt: T,
): Promise<{ projects: number; stages: number; agents: number }> =>
  await tt.run(async (ctx) => ({
    projects: (await ctx.db.query("projects").collect()).length,
    stages: (await ctx.db.query("stages").collect()).length,
    agents: (await ctx.db.query("agentConfigs").collect()).length,
  }));

describe("cli sync rejects env() refs with no stored value", () => {
  // Agent config is written encrypted; the sync throws without a secret.
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("names the unset variable and writes no agent", async () => {
    const tt = t();
    await seedAccount(tt);

    await expect(sync(tt)).rejects.toThrow(ENV_NAME);

    // The check runs before the first write and the mutation rolls back, so a
    // rejected sync leaves no project, stage or agent behind.
    expect(await rowCounts(tt)).toEqual({ projects: 0, stages: 0, agents: 0 });
  });

  test("bakes the value in once it is set", async () => {
    const tt = t();
    await seedAccount(tt);
    await setEnv(tt, "sk-live-1");

    await sync(tt);

    expect(await runtimeValue(tt)).toBe("sk-live-1");
  });
});

describe("removing an env var a synced resource still reads", () => {
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("refuses and names the agent holding the reference", async () => {
    const tt = t();
    await seedAccount(tt);
    await setEnv(tt, "sk-live-1");
    await sync(tt);

    // Without this the delete strips the value and leaves the agent config
    // holding a `${NAME}` nothing can resolve, the state sync now rejects.
    await expect(removeEnv(tt)).rejects.toThrow(
      `still referenced by agent "${agentResource.name}"`,
    );
    expect(await storedEnvCount(tt)).toBe(1);
    expect(await runtimeValue(tt)).toBe("sk-live-1");
  });

  test("refuses for a sandbox reference too", async () => {
    const tt = t();
    await seedAccount(tt);
    await setEnv(tt, "sk-live-1");
    await syncResources(tt, [plainAgentResource, sandboxResource]);

    await expect(removeEnv(tt)).rejects.toThrow(
      `still referenced by sandbox "${sandboxResource.name}"`,
    );
    expect(await storedEnvCount(tt)).toBe(1);
  });

  test("allows the removal once nothing references it", async () => {
    const tt = t();
    await seedAccount(tt);
    await setEnv(tt, "sk-live-1");
    await sync(tt);
    await syncResources(tt, [plainAgentResource]);

    expect(await removeEnv(tt)).toEqual({ removed: true });
    expect(await storedEnvCount(tt)).toBe(0);
  });
});
