/// <reference types="vite/client" />
/** An `env("NAME")` with no stored value must fail the sync, not warn. */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
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

const sync = (tt: T) =>
  tt.mutation(internal.cliSync.syncManifestBySecretHash, {
    secretHash: SECRET_HASH,
    manifest: {
      version: 1 as const,
      project: PROJECT,
      stage: STAGE,
      resources: [agentResource],
    },
  });

/** What the harness actually receives: the config keeps `${NAME}`, the value
 * rides along in the agent's encrypted runtime variables. */
const runtimeValue = (tt: T) =>
  tt.run(async (ctx) => {
    const config = await ctx.db.query("agentConfigs").first();
    if (!config) throw new Error("Agent config was not synced");

    return (await loadAgentRuntimeSecrets(ctx, config._id))[ENV_NAME];
  });

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

    // The mutation rolls back, so a failed sync leaves the stage untouched
    // rather than half-applied.
    expect(await tt.run((ctx) => ctx.db.query("agentConfigs").first())).toBe(
      null,
    );
  });

  test("bakes the value in once it is set", async () => {
    const tt = t();
    await seedAccount(tt);
    await tt.mutation(internal.cliSync.setEnvBySecretHash, {
      secretHash: SECRET_HASH,
      project: PROJECT,
      stage: STAGE,
      name: ENV_NAME,
      value: "sk-live-1",
    });

    await sync(tt);

    expect(await runtimeValue(tt)).toBe("sk-live-1");
  });
});
