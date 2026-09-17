/// <reference types="vite/client" />
/**
 * `harness`, `policies` and `denyTools` must reach the encrypted blob core
 * reads on every path that rebuilds it from the flat `agentConfigs` row.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { CliManifestResource } from "../cli/types";
import type { Id } from "../_generated/dataModel";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
  type NestedAgentConfig,
} from "../model/agentConfigCodec";
import { pushEncryptedConfigToAgentRow } from "../model/agentSync";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const SECRET = "test-config-secret";
const SECRET_HASH = "hash-branches";
const PROJECT = "branches";
const STAGE = "development";
const ENV_NAME = "DEEPSEEK_API_KEY";

const sandboxResource: CliManifestResource = {
  kind: "sandbox",
  name: "coder-sandbox",
  config: { provider: "lambda", size: "xsmall" },
};

const policyResource: CliManifestResource = {
  kind: "policy",
  name: "no-shell",
  config: { version: 1, mode: "enforce", rules: [] },
};

const harnessAgent: CliManifestResource = {
  kind: "agent",
  name: "coder",
  config: {
    provider: { deepseek: { apiKey: { __beeblastEnv: true, name: ENV_NAME } } },
    model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
    harness: { type: "claude-code", permissionMode: "allow-all" },
    sandboxes: ["coder-sandbox"],
    denyTools: ["bash"],
  },
};

const policyAgent: CliManifestResource = {
  kind: "agent",
  name: "support",
  config: {
    model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
    policies: ["no-shell"],
    denyTools: ["bash"],
  },
};

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

describe("agent config branches core reads", () => {
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", SECRET);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("a deploy writes harness and denyTools into the blob", async () => {
    const tt = t();
    await seedAccount(tt);
    await setEnv(tt, "sk-live-1");

    await deploy(tt);

    expect(await runtimeConfigByName(tt, "coder")).toMatchObject({
      harness: { type: "claude-code", permissionMode: "allow-all" },
      denyTools: ["bash"],
    });
  });

  test("a deploy writes policies as policy ids", async () => {
    const tt = t();
    await seedAccount(tt);
    await setEnv(tt, "sk-live-1");

    await deploy(tt);

    const policyId = await tt.run(
      async (ctx) => (await ctx.db.query("agentPolicies").first())?._id,
    );
    expect(await runtimeConfigByName(tt, "support")).toMatchObject({
      policies: [policyId],
      denyTools: ["bash"],
    });
  });

  test("an env var refresh keeps them", async () => {
    const tt = t();
    await seedAccount(tt);
    await setEnv(tt, "sk-live-1");
    await deploy(tt);

    // Rotating a value the agent references re-encrypts its config.
    await setEnv(tt, "sk-live-2");

    expect(await runtimeConfigByName(tt, "coder")).toMatchObject({
      harness: { type: "claude-code", permissionMode: "allow-all" },
      denyTools: ["bash"],
    });
  });

  test("an API write survives the next push from its config row", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const agentId = await tt.mutation(internal.agent.agents.create, {
      accountId: accountId,
      name: "api-agent",
    });
    const written: NestedAgentConfig = {
      model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
      policies: ["policy_1"],
      denyTools: ["bash"],
    };
    const encrypted = await encryptAgentConfigBlob(written, SECRET);
    // The PATCH route writes the blob, then mirrors it onto the config row.
    await tt.mutation(internal.agent.agents.update, {
      accountId: accountId,
      agentId: agentId,
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
    });

    // A dashboard save or webhook edit re-encrypts from that row.
    await tt.run(async (ctx) => {
      const config = await ctx.db
        .query("agentConfigs")
        .withIndex("by_agentId", (q) => q.eq("agentId", agentId))
        .first();
      if (!config) throw new Error("API agent has no config row");
      await pushEncryptedConfigToAgentRow(ctx, config._id);
    });

    expect(await runtimeConfigByName(tt, "api-agent")).toMatchObject({
      policies: ["policy_1"],
      denyTools: ["bash"],
    });
  });
});

async function deploy(tt: T): Promise<void> {
  await tt.mutation(internal.cli.sync.syncManifestBySecretHash, {
    secretHash: SECRET_HASH,
    manifest: {
      version: 1,
      project: PROJECT,
      stage: STAGE,
      resources: [sandboxResource, policyResource, harnessAgent, policyAgent],
    },
  });
}

/** Decrypts the `agents` row blob, the config core runs with. */
async function runtimeConfigByName(
  tt: T,
  name: string,
): Promise<NestedAgentConfig | null> {
  const row = await tt.run(async (ctx) =>
    (await ctx.db.query("agents").collect()).find(
      (agent) => agent.name === name,
    ),
  );
  if (!row?.encryptedConfig || !row.encryptionIv || !row.encryptionTag) {
    throw new Error(`Agent "${name}" has no encrypted config`);
  }

  return await decryptAgentConfigBlob(
    {
      ciphertext: row.encryptedConfig,
      iv: row.encryptionIv,
      tag: row.encryptionTag,
    },
    SECRET,
  );
}

/** Seeds the org, account and owner membership a CLI sync writes against. */
async function seedAccount(tt: T): Promise<Id<"accounts">> {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner@example.com",
      plan: "free",
      createdAt: now,
    });
    const userId = await ctx.db.insert("users", {
      authId: "auth_owner@example.com",
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
      secretHash: SECRET_HASH,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function setEnv(tt: T, value: string): Promise<void> {
  await tt.mutation(internal.cli.sync.setEnvBySecretHash, {
    secretHash: SECRET_HASH,
    project: PROJECT,
    stage: STAGE,
    name: ENV_NAME,
    value: value,
  });
}
