/// <reference types="vite/client" />
/** What a connection-holding process sees: a channel's bot token and the webhook to post to. */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptAgentConfigBlob } from "../model/agentConfigCodec";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const SECRET = "test-config-encryption-secret";

type Scope = {
  accountId: Id<"accounts">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
};

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

beforeEach(() => {
  process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET = SECRET;
});

/** An org, account, project and one stage. `kind: null` seeds a legacy row. */
async function seedScope(
  tt: T,
  kind: "development" | "production" | null = "development",
): Promise<Scope> {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner@example.com",
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast-dev",
      secretHash: "hash-channel-connections",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner@example.com",
      orgId: orgId,
      name: "tracy",
      slug: "tracy",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner@example.com",
      projectId: projectId,
      name: "Development",
      ...(kind ? { kind: kind } : {}),
      isDefault: true,
      updatedAt: now,
    });

    return {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}

/** An agent row with an encrypted config, wired into the stage by an agentConfig. */
async function seedAgent(
  tt: T,
  scope: Scope,
  name: string,
  config: Record<string, unknown>,
): Promise<Id<"agents">> {
  const blob = await encryptAgentConfigBlob(config, SECRET);

  return await tt.run(async (ctx) => {
    const now = Date.now();
    const agentId = await ctx.db.insert("agents", {
      accountId: scope.accountId,
      name: name,
      encryptedConfig: blob.ciphertext,
      encryptionIv: blob.iv,
      encryptionTag: blob.tag,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("agentConfigs", {
      authId: "auth_owner@example.com",
      name: name,
      agentId: agentId,
      projectId: scope.projectId,
      stageId: scope.stageId,
      updatedAt: now,
    });

    return agentId;
  });
}

async function seedDeployment(
  tt: T,
  scope: Scope,
  endpointId: string,
  status: "active" | "revoked" = "active",
): Promise<void> {
  await tt.run(async (ctx) => {
    await ctx.db.insert("agentDeployments", {
      authId: "auth_owner@example.com",
      accountId: scope.accountId,
      projectId: scope.projectId,
      stageId: scope.stageId,
      status: status,
      endpointId: endpointId,
      projectSlug: "tracy",
      stageSlug: "development",
      apiKeyHash: `hash-${endpointId}`,
      keyHint: "fp_agent_…abcd",
      apiKeyCiphertext: "ct",
      apiKeyIv: "iv",
      apiKeyTag: "tag",
      updatedAt: Date.now(),
    });
  });
}

const discordConfig = (botToken: string): Record<string, unknown> => ({
  channels: { discord: { botToken: botToken, publicKey: "pk" } },
});

const channelConfig = (
  channel: string,
  botToken: string,
): Record<string, unknown> => ({
  channels: { [channel]: { botToken: botToken } },
});

describe("listConnections", () => {
  test("returns the bot token and the stage-scoped webhook path", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    const agentId = await seedAgent(
      tt,
      scope,
      "tracy",
      discordConfig("bot-token-1"),
    );
    await seedDeployment(tt, scope, "endpoint-1");

    expect(
      await tt.query(internal.channelConnections.listConnections, {
        channel: "discord",
      }),
    ).toEqual([
      {
        agentId: agentId,
        agentName: "tracy",
        botToken: "bot-token-1",
        webhookPath: `/webhooks/${scope.accountId}/dev/endpoint-1/discord`,
      },
    ]);
  });

  test("a production stage keeps the bare webhook path", async () => {
    const tt = t();
    const scope = await seedScope(tt, "production");
    await seedAgent(tt, scope, "tracy", discordConfig("bot-token-1"));
    await seedDeployment(tt, scope, "endpoint-1");

    const connections = await tt.query(
      internal.channelConnections.listConnections,
      { channel: "discord" },
    );

    expect(connections[0]?.webhookPath).toBe(
      `/webhooks/${scope.accountId}/discord`,
    );
  });

  test("a legacy stage with no kind is treated as production", async () => {
    const tt = t();
    const scope = await seedScope(tt, null);
    await seedAgent(tt, scope, "tracy", discordConfig("bot-token-1"));
    await seedDeployment(tt, scope, "endpoint-1");

    const connections = await tt.query(
      internal.channelConnections.listConnections,
      { channel: "discord" },
    );

    expect(connections[0]?.webhookPath).toBe(
      `/webhooks/${scope.accountId}/discord`,
    );
  });

  test("skips an agent whose Discord config has no bot token", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    await seedAgent(tt, scope, "interactions-only", {
      channels: { discord: { publicKey: "pk" } },
    });
    await seedDeployment(tt, scope, "endpoint-1");

    expect(
      await tt.query(internal.channelConnections.listConnections, {
        channel: "discord",
      }),
    ).toEqual([]);
  });

  test("skips an agent with no Discord channel at all", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    await seedAgent(tt, scope, "slack-only", {
      channels: { slack: { botToken: "xoxb-1" } },
    });
    await seedDeployment(tt, scope, "endpoint-1");

    expect(
      await tt.query(internal.channelConnections.listConnections, {
        channel: "discord",
      }),
    ).toEqual([]);
  });

  test("skips a revoked deployment, which has no live webhook", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    await seedAgent(tt, scope, "tracy", discordConfig("bot-token-1"));
    await seedDeployment(tt, scope, "endpoint-1", "revoked");

    expect(
      await tt.query(internal.channelConnections.listConnections, {
        channel: "discord",
      }),
    ).toEqual([]);
  });

  test("skips an undeployed stage, which has no endpointId to address", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    await seedAgent(tt, scope, "tracy", discordConfig("bot-token-1"));

    expect(
      await tt.query(internal.channelConnections.listConnections, {
        channel: "discord",
      }),
    ).toEqual([]);
  });

  test("returns one row per agent when two share a bot token", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    await seedAgent(tt, scope, "tracy", discordConfig("shared-token"));
    await seedAgent(tt, scope, "triage", discordConfig("shared-token"));
    await seedDeployment(tt, scope, "endpoint-1");

    const connections = await tt.query(
      internal.channelConnections.listConnections,
      { channel: "discord" },
    );

    expect(connections).toHaveLength(2);
    expect(new Set(connections.map((entry) => entry.botToken))).toEqual(
      new Set(["shared-token"]),
    );
    // Named, not counted: two rows for the same agent would also be length 2.
    expect(new Set(connections.map((entry) => entry.agentName))).toEqual(
      new Set(["tracy", "triage"]),
    );
  });

  test("refuses to answer at all without the encryption secret", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    await seedAgent(tt, scope, "tracy", discordConfig("bot-token-1"));
    await seedDeployment(tt, scope, "endpoint-1");
    delete process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;

    // Every poll fails on this, so it must throw rather than read as "no agents
    // configure Discord" and quietly close every socket.
    await expect(
      tt.query(internal.channelConnections.listConnections, {
        channel: "discord",
      }),
    ).rejects.toThrow("ACCOUNT_CONFIG_ENCRYPTION_SECRET");
  });

  test.each(["telegram", "slack", "zalo"])(
    "reads %s the same way, with the channel in the webhook path",
    async (channel) => {
      const tt = t();
      const scope = await seedScope(tt);
      await seedAgent(tt, scope, "tracy", channelConfig(channel, "token-1"));
      await seedDeployment(tt, scope, "endpoint-1");

      expect(
        await tt.query(internal.channelConnections.listConnections, {
          channel: channel,
        }),
      ).toEqual([
        {
          agentId: expect.any(String),
          agentName: "tracy",
          botToken: "token-1",
          webhookPath: `/webhooks/${scope.accountId}/dev/endpoint-1/${channel}`,
        },
      ]);
    },
  );

  test("one channel's token never answers for another", async () => {
    const tt = t();
    const scope = await seedScope(tt);
    await seedAgent(tt, scope, "tracy", channelConfig("slack", "xoxb-1"));
    await seedDeployment(tt, scope, "endpoint-1");

    expect(
      await tt.query(internal.channelConnections.listConnections, {
        channel: "discord",
      }),
    ).toEqual([]);
  });
});
