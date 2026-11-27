import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  createIncomingEventRouter,
  resetChannelAgentListsForTests,
  type ChannelContextEvent,
  type ChannelInboundEvent,
  type IntegrationRoutingOptions,
} from "../../../../apps/core/src/harness/integrations.ts";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";
import type { AgentRecord } from "../../../../apps/core/src/shared/domain/agents.ts";
import type { ChannelRecord } from "../../../../apps/core/src/shared/domain/channel-record.ts";
import type { AgentDeploymentScope } from "../../../../apps/core/src/shared/storage.ts";
import { discordForwarderToken } from "../../../../apps/core/src/shared/discord-wire.ts";
import { coreRequest } from "../../../../apps/core/tests/helpers/http.ts";

interface Collected {
  contexts: ChannelContextEvent[];
  turns: ChannelInboundEvent[];
}

const TELEGRAM_SECRET = "telegram-secret-value";
const ORIGINAL_FETCH = globalThis.fetch;
const STAMP = "2026-07-20T00:00:00.000Z";

const ACCOUNT = {
  accountId: "acct_test",
  username: "test-account",
  description: "Test account",
  secretHash: "hash",
  status: "active" as const,
  config: {},
  createdAt: STAMP,
  updatedAt: STAMP,
};

const DISCORD_CONFIG: AgentConfig = {
  channels: {
    discord: {
      botToken: "discord-token",
      publicKey: "a".repeat(64),
      botUserId: "bot-9",
    },
  },
};

const TELEGRAM_CONFIG: AgentConfig = {
  channels: {
    telegram: {
      botToken: "telegram-token",
      webhookSecret: TELEGRAM_SECRET,
      allowedChannelIds: ["123"],
    },
  },
};

beforeEach((): void => {
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => Response.json({ ok: true }),
    { preconnect: ORIGINAL_FETCH.preconnect },
  );
  resetChannelAgentListsForTests();
});

afterEach((): void => {
  globalThis.fetch = ORIGINAL_FETCH;
  resetChannelAgentListsForTests();
});

function agent(agentId: string, config: AgentConfig): AgentRecord {
  return {
    accountId: "acct_test",
    agentId: agentId,
    name: agentId,
    config: config,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function record(overrides: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    accountId: "acct_test",
    channelRecordId: "chan_1",
    platform: "discord",
    externalId: "channel-1",
    name: "#support",
    config: { agentBindings: [{ agentId: "agent_sales" }] },
    status: "active",
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

function discordRequest(): ReturnType<typeof coreRequest> {
  return coreRequest(
    "POST",
    "/v1/webhooks/acct_test/discord",
    { "x-discord-gateway-token": discordForwarderToken("discord-token") },
    {
      type: "GATEWAY_MESSAGE_CREATE",
      data: {
        id: "message-1",
        channel_id: "channel-1",
        content: "just chatting",
        guild_id: "guild-1",
        mentions: [],
        mention_roles: [],
        author: { id: "user-1", username: "ada", bot: false },
      },
    },
  );
}

function telegramRequest(
  secret: string = TELEGRAM_SECRET,
  path: string = "/v1/webhooks/acct_test/telegram",
): ReturnType<typeof coreRequest> {
  return coreRequest(
    "POST",
    path,
    { "x-telegram-bot-api-secret-token": secret },
    {
      update_id: 7,
      message: {
        message_id: 9,
        date: 1713916800,
        text: "hello",
        chat: { id: 123, type: "private" },
        from: { id: 456, is_bot: false, username: "alice" },
      },
    },
  );
}

async function route(
  request: ReturnType<typeof coreRequest>,
  options: IntegrationRoutingOptions,
): Promise<{ status: number; collected: Collected }> {
  const collected: Collected = { contexts: [], turns: [] };
  const waited: Promise<unknown>[] = [];
  const router = createIncomingEventRouter({
    accountLoader: async (): Promise<typeof ACCOUNT> => ACCOUNT,
    deploymentLoader: async (): Promise<null> => null,
    channelRecordLoader: async (): Promise<null> => null,
    ...options,
    waitUntil: (promise: Promise<unknown>): void => {
      waited.push(Promise.resolve(promise).catch((): void => {}));
    },
  });
  const response = await router(request, {
    handleDirectRequest: async (): Promise<Response> => new Response("ok"),
    handleChannelRequest: async (event): Promise<void> => {
      collected.turns.push(event);
    },
    handleChannelContext: async (event): Promise<void> => {
      collected.contexts.push(event);
    },
  });
  await Promise.all(waited);

  return { status: response.status, collected: collected };
}

describe("acceptChannelTurn context messages", (): void => {
  const support = agent("agent_support", DISCORD_CONFIG);
  const sales = agent("agent_sales", DISCORD_CONFIG);

  test("stores an unaddressed message as context for the receiving agent", async (): Promise<void> => {
    const { status, collected } = await route(discordRequest(), {
      agentLoader: async (): Promise<AgentRecord> => support,
      agentLister: async (): Promise<AgentRecord[]> => [support],
    });

    expect(status).toBe(200);
    expect(collected.turns).toHaveLength(0);
    expect(collected.contexts).toHaveLength(1);
    expect(collected.contexts[0]).toMatchObject({
      accountId: "acct_test",
      agentId: "agent_support",
      channelName: "discord",
    });
  });

  test("drops the context when the channel record lookup fails", async (): Promise<void> => {
    const { status, collected } = await route(discordRequest(), {
      agentLoader: async (): Promise<AgentRecord> => support,
      agentLister: async (): Promise<AgentRecord[]> => [support],
      channelRecordLoader: async (): Promise<never> => {
        throw new Error("convex unreachable");
      },
    });

    expect(status).toBe(200);
    expect(collected.contexts).toHaveLength(0);
  });

  test("gives the context to the agent the record binds, with its deployment", async (): Promise<void> => {
    const asked: string[] = [];
    const { collected } = await route(discordRequest(), {
      agentLoader: async (
        _accountId: string,
        agentId: string,
      ): Promise<AgentRecord> => (agentId === "agent_sales" ? sales : support),
      agentLister: async (): Promise<AgentRecord[]> => [support],
      channelRecordLoader: async (): Promise<ChannelRecord> =>
        record({ workspaceRef: "guild-1" }),
      deploymentLoader: async (
        _accountId: string,
        agentId: string,
      ): Promise<AgentDeploymentScope> => {
        asked.push(agentId);

        return {
          accountId: "acct_test",
          endpointId: "endpoint-sales",
          projectSlug: "shop",
          stageSlug: "dev",
        };
      },
    });

    expect(asked).toContain("agent_sales");
    expect(collected.contexts[0]).toMatchObject({
      agentId: "agent_sales",
      endpointId: "endpoint-sales",
      projectSlug: "shop",
      stageSlug: "dev",
    });
  });

  test("ignores a record that belongs to another provider workspace", async (): Promise<void> => {
    const { collected } = await route(discordRequest(), {
      agentLoader: async (): Promise<AgentRecord> => support,
      agentLister: async (): Promise<AgentRecord[]> => [support],
      channelRecordLoader: async (): Promise<ChannelRecord> =>
        record({ workspaceRef: "guild-other" }),
    });

    expect(collected.contexts[0]?.agentId).toBe("agent_support");
  });
});

describe("handleChannelWebhook", (): void => {
  test("answers 500 when the deployment lookup fails", async (): Promise<void> => {
    const telegram = agent("agent_tg", TELEGRAM_CONFIG);
    const { status, collected } = await route(telegramRequest(), {
      agentLoader: async (): Promise<AgentRecord> => telegram,
      agentLister: async (): Promise<AgentRecord[]> => [telegram],
      deploymentLoader: async (): Promise<never> => {
        throw new Error("deployments unreachable");
      },
    });

    expect(status).toBe(500);
    expect(collected.turns).toHaveLength(0);
  });
});

describe("scanChannelCredentialHolder", (): void => {
  test("tries only the first candidates, sorted by agent id", async (): Promise<void> => {
    const agents = Array.from({ length: 27 }, (_value, index): AgentRecord =>
      agent(
        `agent_${String(index).padStart(2, "0")}`,
        index === 26
          ? {
              channels: {
                telegram: {
                  botToken: "late-token",
                  webhookSecret: "late-secret",
                  allowedChannelIds: ["123"],
                },
              },
            }
          : TELEGRAM_CONFIG,
      ),
    );

    const { status, collected } = await route(telegramRequest("late-secret"), {
      agentLoader: async (
        _accountId: string,
        agentId: string,
      ): Promise<AgentRecord | null> =>
        agents.find((item): boolean => item.agentId === agentId) ?? null,
      agentLister: async (): Promise<AgentRecord[]> => agents,
    });

    expect(status).toBe(401);
    expect(collected.turns).toHaveLength(0);
  });
});

describe("cachedChannelAgentList", (): void => {
  test("drops expired listings and a listing that failed to load", async (): Promise<void> => {
    const telegram = agent("agent_tg", TELEGRAM_CONFIG);
    const clock = spyOn(Date, "now");
    const base = Date.now();
    clock.mockReturnValue(base);
    let listings = 0;
    let failing = false;
    const options: IntegrationRoutingOptions = {
      agentLoader: async (): Promise<AgentRecord> => telegram,
      agentLister: async (): Promise<AgentRecord[]> => {
        listings += 1;
        if (failing) throw new Error("listing failed");

        return [telegram];
      },
      cacheAgentLists: true,
    };
    try {
      await route(
        telegramRequest("wrong", "/v1/webhooks/acct_test/telegram"),
        options,
      );
      clock.mockReturnValue(base + 11_000);
      await route(
        telegramRequest("wrong", "/v1/webhooks/acct_test/telegram"),
        options,
      );
      failing = true;
      clock.mockReturnValue(base + 30_000);
      const failed = await route(telegramRequest(), options);
      failing = false;
      const again = await route(telegramRequest("wrong"), options);

      expect(listings).toBe(4);
      expect(failed.status).toBe(503);
      expect(again.status).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("reverifyReceivers", (): void => {
  test("answers 503 when the fresh receiver reload fails", async (): Promise<void> => {
    const telegram = agent("agent_tg", TELEGRAM_CONFIG);
    let listings = 0;
    const { status, collected } = await route(telegramRequest(), {
      agentLoader: async (): Promise<AgentRecord> => telegram,
      agentLister: async (): Promise<AgentRecord[]> => {
        listings += 1;
        if (listings > 1) throw new Error("reload failed");

        return [telegram];
      },
      cacheAgentLists: true,
    });

    expect(status).toBe(503);
    expect(collected.turns).toHaveLength(0);
  });
});
