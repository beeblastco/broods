/// <reference types="vite/client" />
/** `config.mcp` is keyed by mcp row id at rest, never by server name (#331). */

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { CliManifestResource } from "../cli/types";
import { accountCipher } from "../model/accountKeys";
import {
  REDACTED_SECRET_VALUE,
  redactConfigSecrets,
} from "../model/configValues";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const PROJECT = "mcp-connect";
const STAGE = "development";
const SECRET_HASH = "hash-mcp-refs";
const SERVER_NAME = "search";
const TOKEN_HEADER = { Authorization: "Bearer ${SEARCH_TOKEN}" };

const mcpResource = {
  kind: "mcp" as const,
  name: SERVER_NAME,
  description: "Company search backend.",
  config: {
    url: "https://mcp.example.com/mcp",
  },
};

const t = (): TestConvex<typeof schema> => convexTest(schema, modules);
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
  headers?: Record<string, string>,
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
    ...(headers ? { headers: headers } : {}),
  });
  await tt.mutation(internal.cli.sync.recordExternalResourcesBySecretHash, {
    secretHash: SECRET_HASH,
    project: PROJECT,
    stage: STAGE,
    resources: [mcpResource],
    ids: {
      skills: {},
      hooks: {},
      mcp: { [SERVER_NAME]: serverId },
    },
  });

  return serverId;
}

function agentResource(mcp: Record<string, unknown>): CliManifestResource {
  return {
    kind: "agent",
    name: "mcp-agent",
    config: {
      model: { provider: "custom", modelId: "Qwen3.6-27B" },
      agent: { system: "Use the search server when asked." },
      mcp: mcp,
    },
  };
}

function storedMcpServers(tt: T): Promise<Record<string, unknown>> {
  return tt.run(async (ctx) => {
    const config = await ctx.db.query("agentConfigs").first();
    const extra = config?.extraConfig as
      | { mcp?: Record<string, unknown> }
      | undefined;

    return extra?.mcp ?? {};
  });
}

const syncMcpServers = (
  tt: T,
  mcp: Record<string, unknown>,
): Promise<unknown> =>
  tt.mutation(internal.cli.sync.syncManifestBySecretHash, {
    secretHash: SECRET_HASH,
    manifest: {
      version: 1 as const,
      project: PROJECT,
      stage: STAGE,
      resources: [mcpResource, agentResource(mcp)],
    },
  });

/** The `config.mcp` core decrypts for a run, with every `${NAME}` resolved. */
function runtimeMcpServers(
  tt: T,
  accountId: Id<"accounts">,
): Promise<Record<string, { headers?: Record<string, string> }>> {
  return tt.run(async (ctx) => {
    const agent = await ctx.db.query("agents").first();
    const config = await (
      await accountCipher(ctx, accountId)
    ).decrypt("agents:encryptedConfig", {
      ciphertext: agent!.encryptedConfig!,
      iv: agent!.encryptionIv!,
      tag: agent!.encryptionTag!,
    });

    return (
      config as { mcp: Record<string, { headers?: Record<string, string> }> }
    ).mcp;
  });
}

describe("cli sync rewrites config.mcp names to mcp row ids", () => {
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

    // A name left in place fails normalizeMcpConfig at the next write,
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
    expect((agent!.config as { mcp: unknown }).mcp).toEqual({
      [SERVER_NAME]: { enabled: true },
    });
    expect(read!.ids.mcp).toEqual({ [SERVER_NAME]: serverId });
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

  test("draws a canvas node for a synced mcp server and links its row", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const serverId = await seedMcpServer(tt, accountId);

    await syncMcpServers(tt, { [SERVER_NAME]: { enabled: true } });

    const layout = await tt.run(
      async (ctx) => await ctx.db.query("canvasLayouts").first(),
    );
    const mcpNode = (
      (layout?.nodes ?? []) as Array<{
        id: string;
        type: string;
        data?: { resourceId?: string };
      }>
    ).find((node) => node.type === "mcp" && node.data?.resourceId === serverId);
    const server = await tt.run(async (ctx) => await ctx.db.get(serverId));

    // The dashboard panel resolves through getByNode (by_stageId_and_nodeId),
    // so without this link a CLI-defined server is invisible on the canvas.
    expect(mcpNode).toBeDefined();
    expect(server!.nodeId).toBe(mcpNode!.id);
  });
});

describe("cli sync resolves an mcp server's secret headers per agent", () => {
  beforeEach(() => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The CLI copies a server's headers into each agent that connects it.
  test("bakes a ${NAME} header into the runtime config only", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const serverId = await seedMcpServer(tt, accountId, TOKEN_HEADER);
    await tt.mutation(internal.cli.sync.setEnvBySecretHash, {
      secretHash: SECRET_HASH,
      project: PROJECT,
      stage: STAGE,
      name: "SEARCH_TOKEN",
      value: "tok-1",
    });

    await syncMcpServers(tt, {
      [SERVER_NAME]: { enabled: true, headers: TOKEN_HEADER },
    });

    // Core refuses a run whose header still carries the ref.
    expect((await runtimeMcpServers(tt, accountId))[serverId]).toEqual({
      enabled: true,
      headers: { Authorization: "Bearer tok-1" },
    });
    expect(await storedMcpServers(tt)).toEqual({
      [serverId]: { enabled: true, headers: TOKEN_HEADER },
    });
  });

  test("refuses the sync when a header names an unset variable", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    await seedMcpServer(tt, accountId, TOKEN_HEADER);

    await expect(
      syncMcpServers(tt, {
        [SERVER_NAME]: { enabled: true, headers: TOKEN_HEADER },
      }),
    ).rejects.toThrow("SEARCH_TOKEN");
  });
});

describe("public config projection", () => {
  test("masks resolved credential headers and keeps refs", () => {
    expect(
      redactConfigSecrets({
        mcp: {
          search: {
            headers: {
              Accept: "application/json",
              Authorization: "Bearer tok-1",
              "X-Api-Key": "fc-1",
              "X-Other-Key": "Bearer ${OTHER_KEY}",
              "X-Passwd": "hunter2",
            },
          },
        },
      }),
    ).toEqual({
      mcp: {
        search: {
          headers: {
            Accept: "application/json",
            Authorization: REDACTED_SECRET_VALUE,
            "X-Api-Key": REDACTED_SECRET_VALUE,
            "X-Other-Key": "Bearer ${OTHER_KEY}",
            "X-Passwd": REDACTED_SECRET_VALUE,
          },
        },
      },
    });
  });
});

describe("internal mcp update", () => {
  test("clears the optional fields a declarative sync dropped", async () => {
    const tt = t();
    const accountId = await seedAccount(tt);
    const serverId = await seedMcpServer(tt, accountId, TOKEN_HEADER);
    await tt.mutation(internal.account.mcp.update, {
      accountId: accountId,
      serverId: serverId,
      allowedTools: ["query"],
    });

    await tt.mutation(internal.account.mcp.update, {
      accountId: accountId,
      serverId: serverId,
      clear: ["allowedTools", "headers"],
    });

    // A stale allowedTools would silently hide every renamed tool.
    const row = await tt.run(async (ctx) => await ctx.db.get(serverId));
    expect(row!.allowedTools).toBeUndefined();
    expect(row!.headers).toBeUndefined();
  });
});
