/// <reference types="vite/client" />
/** `config.mcpServers` is keyed by mcp row id at rest, never by server name (#331). */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { CliManifestResource } from "../cli/types";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const PROJECT = "mcp-connect";
const STAGE = "development";
const SECRET_HASH = "hash-mcp-refs";
const SERVER_NAME = "search";

const mcpResource = {
  kind: "mcp" as const,
  name: SERVER_NAME,
  description: "Company search backend.",
  config: {
    url: "https://mcp.example.com/mcp",
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

/** The synced mcp row plus the CLI's name → id record for the stage. */
async function seedMcpServer(
  tt: T,
  accountId: Id<"accounts">,
): Promise<Id<"mcp">> {
  const scope = await tt.mutation(internal.cli.sync.ensureScopeBySecretHash, {
    secretHash: SECRET_HASH,
    project: PROJECT,
    stage: STAGE,
  });
  const serverId = await tt.mutation(internal.account.mcp.create, {
    accountId: accountId,
    projectId: scope.projectId,
    stageId: scope.stageId,
    name: SERVER_NAME,
    url: mcpResource.config.url,
  });
  await tt.mutation(internal.cli.sync.recordExternalResourcesBySecretHash, {
    secretHash: SECRET_HASH,
    project: PROJECT,
    stage: STAGE,
    resources: [mcpResource],
    ids: {
      skills: {},
      tools: {},
      hooks: {},
      mcpServers: { [SERVER_NAME]: serverId },
    },
  });

  return serverId;
}

function agentResource(
  mcpServers: Record<string, unknown>,
): CliManifestResource {
  return {
    kind: "agent",
    name: "mcp-agent",
    config: {
      model: { provider: "custom", modelId: "Qwen3.6-27B" },
      agent: { system: "Use the search server when asked." },
      mcpServers: mcpServers,
    },
  };
}

function storedMcpServers(tt: T): Promise<Record<string, unknown>> {
  return tt.run(async (ctx) => {
    const config = await ctx.db.query("agentConfigs").first();
    const extra = config?.extraConfig as
      | { mcpServers?: Record<string, unknown> }
      | undefined;

    return extra?.mcpServers ?? {};
  });
}

const syncMcpServers = (
  tt: T,
  mcpServers: Record<string, unknown>,
): Promise<unknown> =>
  tt.mutation(internal.cli.sync.syncManifestBySecretHash, {
    secretHash: SECRET_HASH,
    manifest: {
      version: 1 as const,
      project: PROJECT,
      stage: STAGE,
      resources: [mcpResource, agentResource(mcpServers)],
    },
  });

describe("cli sync rewrites config.mcpServers names to mcp row ids", () => {
  // Agent config is written encrypted; the sync throws without a secret.
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("stores a server by id, and reads it back as its name", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const serverId = await seedMcpServer(tt, accountId);

    await syncMcpServers(tt, { [SERVER_NAME]: { enabled: true } });

    // A name left in place fails normalizeMcpServersConfig at the next write,
    // and the harness would never resolve the row.
    expect(await storedMcpServers(tt)).toEqual({
      [serverId]: { enabled: true },
    });

    const read = await tt.query(internal.cli.sync.getManifestBySecretHash, {
      secretHash: SECRET_HASH,
      project: PROJECT,
      stage: STAGE,
    });
    const agent = (
      read!.manifest as { resources: Array<{ kind: string; config: unknown }> }
    ).resources.find((entry) => entry.kind === "agent");
    expect((agent!.config as { mcpServers: unknown }).mcpServers).toEqual({
      [SERVER_NAME]: { enabled: true },
    });
    expect(read!.ids.mcpServers).toEqual({ [SERVER_NAME]: serverId });
  });

  test("re-syncing an already-rewritten id is a no-op", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const serverId = await seedMcpServer(tt, accountId);

    await syncMcpServers(tt, { [serverId]: { enabled: true } });

    expect(await storedMcpServers(tt)).toEqual({
      [serverId]: { enabled: true },
    });
  });
});
