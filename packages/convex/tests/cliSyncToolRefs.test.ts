/// <reference types="vite/client" />
/** `config.tools` is keyed by account tool id at rest, never by tool name. */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const PROJECT = "tool-custom-sandbox";
const ENVIRONMENT = "development";
const SECRET_HASH = "hash-tool-refs";
const TOOL_NAME = "system_report";

const toolResource = {
  kind: "tool" as const,
  name: TOOL_NAME,
  description: "Hashes a string inside the sandbox runtime.",
  config: {
    path: "agents.ts",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
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

/** The uploaded tool row plus the CLI's name → id record for the environment. */
async function seedUploadedTool(
  tt: T,
  accountId: Id<"accounts">,
): Promise<string> {
  const now = Date.now();
  const toolId = await tt.run(
    async (ctx) =>
      await ctx.db.insert("accountTools", {
        accountId: accountId,
        name: TOOL_NAME,
        description: toolResource.description,
        inputSchema: toolResource.config.inputSchema,
        bundleStorageKey: `account-tools/${accountId}/bundles/hash.mjs`,
        sha256: "a".repeat(64),
        runtime: "sandbox" as const,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      }),
  );
  await tt.mutation(internal.cliSync.recordExternalResourcesBySecretHash, {
    secretHash: SECRET_HASH,
    project: PROJECT,
    environment: ENVIRONMENT,
    resources: [toolResource],
    ids: { skills: {}, tools: { [TOOL_NAME]: toolId }, hooks: {} },
  });

  return toolId;
}

const agentResource = (tools: Record<string, unknown>) => ({
  kind: "agent" as const,
  name: "sandbox-tool-agent",
  config: {
    model: { provider: "custom", modelId: "Qwen3.6-27B" },
    agent: { system: "Call system_report when asked." },
    tools: tools,
  },
});

const storedTools = (tt: T) =>
  tt.run(async (ctx) => {
    const config = await ctx.db.query("agentConfigs").first();
    const extra = config?.extraConfig as
      | { tools?: Record<string, unknown> }
      | undefined;

    return extra?.tools ?? {};
  });

const syncTools = (tt: T, tools: Record<string, unknown>) =>
  tt.mutation(internal.cliSync.syncManifestBySecretHash, {
    secretHash: SECRET_HASH,
    manifest: {
      version: 1 as const,
      project: PROJECT,
      environment: ENVIRONMENT,
      resources: [toolResource, agentResource(tools)],
    },
  });

describe("cli sync rewrites config.tools names to account tool ids", () => {
  // Agent config is written encrypted; the sync throws without a secret.
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("stores an uploaded tool by id, and reads it back as a name", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const toolId = await seedUploadedTool(tt, accountId);

    await syncTools(tt, { [TOOL_NAME]: { enabled: true } });

    // A name left in place here reaches the harness as a provider tool key and
    // fails the whole run with "is not a provider-defined tool".
    expect(await storedTools(tt)).toEqual({ [toolId]: { enabled: true } });

    const read = await tt.query(internal.cliSync.getManifestBySecretHash, {
      secretHash: SECRET_HASH,
      project: PROJECT,
      environment: ENVIRONMENT,
    });
    const agent = (
      read!.manifest as { resources: Array<{ kind: string; config: unknown }> }
    ).resources.find((entry) => entry.kind === "agent");
    // The round trip is what `broods dev` diffs against local code, so it has
    // to come back as the name the project declared.
    expect((agent!.config as { tools: unknown }).tools).toEqual({
      [TOOL_NAME]: { enabled: true },
    });
    expect(read!.ids.tools).toEqual({ [TOOL_NAME]: toolId });
  });

  test("re-syncing an already-rewritten id is a no-op", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const toolId = await seedUploadedTool(tt, accountId);

    // The HTTP layer rewrites the manifest before this mutation sees it, so the
    // key usually arrives as an id already. Mapping it twice must not mangle it.
    await syncTools(tt, { [toolId]: { enabled: true } });

    expect(await storedTools(tt)).toEqual({ [toolId]: { enabled: true } });
  });

  test("leaves a provider-defined tool key alone", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    await seedUploadedTool(tt, accountId);

    await syncTools(tt, {
      googleSearch: { enabled: true },
      urlContext: { enabled: true },
    });

    // googleSearch is flattened onto searchToolEnabled; urlContext stays a raw
    // provider key the harness resolves off the provider's own tools namespace.
    expect(await storedTools(tt)).toEqual({
      googleSearch: { enabled: true },
      urlContext: { enabled: true },
    });
  });
});
