/** Channel routing fixtures use credentials generated for this test process. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { AgentRecord } from "../src/shared/domain/agents.ts";
import {
  createIncomingEventRouter as createCoreIncomingEventRouter,
  type ChannelInboundEvent,
  type DirectInboundEvent,
  type IntegrationRoutingOptions,
  resetChannelAgentListsForTests,
} from "../src/harness/integrations.ts";
import {
  getObservabilityContext,
  setObservabilityContext,
} from "../src/shared/otel.ts";
import { coreRequest } from "./helpers/http.ts";

const TELEGRAM_BOT_TOKEN = crypto.randomUUID();
const TELEGRAM_WEBHOOK_SECRET = crypto.randomUUID();

const TEST_ACCOUNT = {
  accountId: "acct_test",
  username: "test-account",
  description: "Test account",
  secretHash: crypto.randomUUID(),
  status: "active" as const,
  config: {
    channels: {
      telegram: {
        botToken: TELEGRAM_BOT_TOKEN,
        webhookSecret: TELEGRAM_WEBHOOK_SECRET,
        allowedChannelIds: ["123"],
      },
    },
  },
  createdAt: "2026-04-24T00:00:00.000Z",
  updatedAt: "2026-04-24T00:00:00.000Z",
};

const TEST_AGENT = {
  accountId: "acct_test",
  agentId: "agent_test",
  name: "Webhook agent",
  status: "active" as const,
  config: TEST_ACCOUNT.config,
  createdAt: "2026-04-24T00:00:00.000Z",
  updatedAt: "2026-04-24T00:00:00.000Z",
};

const PANCAKE_AGENT = {
  ...TEST_AGENT,
  config: {
    channels: {
      pancake: {
        pageId: "page-1",
        pageAccessToken: "page-token",
        webhookSecret: "pancake-secret",
      },
      zalo: {
        botToken: "zalo-handoff-token",
        webhookSecret: "zalo-handoff-secret",
      },
    },
  },
};

const ZALO_AGENT = {
  ...TEST_AGENT,
  config: {
    channels: {
      zalo: {
        botToken: "zalo-token",
        webhookSecret: "zalo-secret",
        allowedUserIds: ["user-1"],
      },
    },
  },
};

const WHATSAPP_AGENT = {
  ...TEST_AGENT,
  config: {
    channels: {
      whatsapp: {
        accessToken: "wa-token",
        appSecret: "wa-app-secret",
        phoneNumberId: "phone-1",
        verifyToken: "wa-verify-token",
      },
    },
  },
};

const ORIGINAL_FETCH = globalThis.fetch;

describe("account webhook ingress", () => {
  // Admitted turns fire typing and reactions through the real adapters, so
  // every test answers them locally instead of calling Meta, Zalo or Telegram.
  beforeEach(() => {
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => Response.json({ ok: true }),
      { preconnect: ORIGINAL_FETCH.preconnect },
    );
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    setObservabilityContext(null);
  });

  it("returns 404 for unknown accounts", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => null,
    });

    const response = await routeIncomingEvent(
      createTelegramEvent(),
      createHandlers(),
    );

    expect(response.statusCode).toBe(404);
    expect(responseJson(response)).toEqual({
      error: {
        message: "Not found",
        type: "not_found_error",
        code: "not_found",
      },
    });
  });

  it("returns 503 when the account has not configured the requested channel", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => ({
        ...TEST_ACCOUNT,
      }),
      agentLoader: async () => ({ ...TEST_AGENT, config: {} }),
      agentLister: async () => [{ ...TEST_AGENT, config: {} }],
    });

    const response = await routeIncomingEvent(
      createTelegramEvent(),
      createHandlers(),
    );

    expect(response.statusCode).toBe(503);
    expect(responseJson(response)).toMatchObject({
      error: { message: "telegram integration is not configured" },
    });
  });

  it("returns 401 when account channel authentication fails", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => TEST_AGENT,
      agentLister: async () => [TEST_AGENT],
    });

    const response = await routeIncomingEvent(
      createTelegramEvent(undefined, {
        "x-telegram-bot-api-secret-token": "wrong",
      }),
      createHandlers(),
    );

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({
      error: {
        message: "Unauthorized",
        type: "authentication_error",
        code: "unauthorized",
      },
    });
  });

  it("reuses a cached agent listing but runs only what verifies now", async () => {
    resetChannelAgentListsForTests();
    let listings = 0;
    let current: AgentRecord | null = TEST_AGENT;
    const handled: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => current,
      agentLister: async () => {
        listings += 1;

        return [TEST_AGENT];
      },
      cacheAgentLists: true,
    });
    const handlers = createHandlers({
      handleChannelRequest: async (event) => {
        handled.push(event);
      },
    });

    const unsigned = await routeIncomingEvent(
      createTelegramEvent(undefined, {
        "x-telegram-bot-api-secret-token": "wrong",
      }),
      handlers,
    );
    const signed = await routeIncomingEvent(createTelegramEvent(), handlers);
    await signed.afterResponse;

    expect(unsigned.statusCode).toBe(401);
    expect(signed.statusCode).toBe(200);
    expect(listings).toBe(1);
    expect(handled).toHaveLength(1);

    // The secret rotated after the listing was cached: the old one no longer
    // runs a turn, and a deleted agent runs nothing.
    current = {
      ...TEST_AGENT,
      config: {
        channels: {
          telegram: {
            ...TEST_ACCOUNT.config.channels.telegram,
            webhookSecret: crypto.randomUUID(),
          },
        },
      },
    };
    const rotated = await routeIncomingEvent(createTelegramEvent(), handlers);
    current = null;
    const deleted = await routeIncomingEvent(createTelegramEvent(), handlers);

    expect(rotated.statusCode).toBe(401);
    expect(deleted.statusCode).toBe(401);
    expect(listings).toBe(1);
    expect(handled).toHaveLength(1);
    resetChannelAgentListsForTests();
  });

  it("returns 401 when Zalo webhook authentication is missing or wrong", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => ZALO_AGENT,
      agentLister: async () => [ZALO_AGENT],
    });

    const missing = await routeIncomingEvent(
      createZaloEvent(undefined, {}),
      createHandlers(),
    );
    expect(missing.statusCode).toBe(401);
    expect(responseJson(missing)).toMatchObject({
      error: { message: "Unauthorized" },
    });

    const wrong = await routeIncomingEvent(
      createZaloEvent(undefined, {
        "x-bot-api-secret-token": "wrong-secret",
      }),
      createHandlers(),
    );
    expect(wrong.statusCode).toBe(401);
    expect(responseJson(wrong)).toMatchObject({
      error: { message: "Unauthorized" },
    });
  });

  it("normalizes account webhook events and schedules channel processing", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => TEST_AGENT,
      agentLister: async () => [TEST_AGENT],
      deploymentLoader: async () => ({
        accountId: "acct_test",
        endpointId: "endpoint-development",
        projectSlug: "project-one",
        stageSlug: "development",
      }),
    });
    let processingScope: ReturnType<typeof getObservabilityContext> = null;

    const response = await routeIncomingEvent(
      createTelegramEvent(),
      createHandlers({
        handleChannelRequest: async (event) => {
          processingScope = getObservabilityContext();
          handledEvents.push(event);
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.afterResponse).toBeDefined();

    await response.afterResponse;

    expect(processingScope).toMatchObject({
      accountId: "acct_test",
      endpointId: "endpoint-development",
      project: "project-one",
      stage: "development",
    });
    expect(getObservabilityContext()).toBeNull();
    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]).toMatchObject({
      accountId: "acct_test",
      agentId: "agent_test",
      agentConfig: {
        channels: {
          telegram: {
            botToken: TELEGRAM_BOT_TOKEN,
            webhookSecret: TELEGRAM_WEBHOOK_SECRET,
            allowedChannelIds: ["123"],
          },
        },
      },
      eventId: "acct:acct_test:agent:agent_test:tg:7",
      conversationKey: "acct:acct_test:agent:agent_test:tg:123",
      content: "hello",
      events: [{ role: "user", content: "hello" }],
      channelName: "telegram",
      endpointId: "endpoint-development",
      projectSlug: "project-one",
      stageSlug: "development",
    });
  });

  it("acks a channel message only once it is admitted", async (): Promise<void> => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => TEST_AGENT,
      agentLister: async () => [TEST_AGENT],
    });
    let admitted = false;

    const response = await routeIncomingEvent(
      createTelegramEvent(),
      createHandlers({
        handleChannelRequest: async (): Promise<void> => {
          await Bun.sleep(20);
          admitted = true;
        },
      }),
    );

    // An ack the provider sees must never front a message core could lose.
    expect(response.statusCode).toBe(200);
    expect(admitted).toBe(true);
  });

  it("normalizes Pancake webhook events through account webhook routing", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => PANCAKE_AGENT,
      agentLister: async () => [PANCAKE_AGENT],
    });

    const response = await routeIncomingEvent(
      createPancakeEvent(),
      createHandlers({
        handleChannelRequest: async (event) => {
          handledEvents.push(event);
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    await response.afterResponse;

    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]).toMatchObject({
      accountId: "acct_test",
      agentId: "agent_test",
      agentConfig: {
        channels: {
          pancake: {
            pageId: "page-1",
            pageAccessToken: "page-token",
            webhookSecret: "pancake-secret",
          },
          zalo: {
            botToken: "zalo-handoff-token",
            webhookSecret: "zalo-handoff-secret",
          },
        },
      },
      conversationKey:
        "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
      content: [{ type: "text", text: "hello pancake" }],
      events: [
        { role: "user", content: [{ type: "text", text: "hello pancake" }] },
      ],
      channelName: "pancake",
    });
    expect(
      handledEvents[0]!.eventId.startsWith(
        "acct:acct_test:agent:agent_test:pancake:page-1:message-1:",
      ),
    ).toBe(true);
  });

  it("normalizes Zalo webhook events through account webhook routing", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => ZALO_AGENT,
      agentLister: async () => [ZALO_AGENT],
    });

    const response = await routeIncomingEvent(
      createZaloEvent(),
      createHandlers({
        handleChannelRequest: async (event) => {
          handledEvents.push(event);
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    await response.afterResponse;

    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]).toMatchObject({
      accountId: "acct_test",
      agentId: "agent_test",
      agentConfig: {
        channels: {
          zalo: {
            botToken: "zalo-token",
            webhookSecret: "zalo-secret",
            allowedUserIds: ["user-1"],
          },
        },
      },
      eventId:
        "acct:acct_test:agent:agent_test:zalo:message.text.received:chat-1:user-1:message-1",
      conversationKey: "acct:acct_test:agent:agent_test:zalo:chat-1",
      content: "hello zalo",
      events: [{ role: "user", content: "hello zalo" }],
      channelName: "zalo",
    });
  });

  it("routes a stage webhook URL to that stage even when a sibling shares credentials", async () => {
    // Both stages hold the same bot secret, so both verify. The account scan
    // sorts on agentId and would take `agent_aaa`; the URL must win instead.
    const productionAgent = { ...ZALO_AGENT, agentId: "agent_aaa" };
    const stageAgent = { ...ZALO_AGENT, agentId: "agent_zzz" };
    const handledEvents: ChannelInboundEvent[] = [];
    const listedEndpoints: string[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => stageAgent,
      agentLister: async () => [productionAgent, stageAgent],
      stageAgentLister: async (_accountId, endpointId) => {
        listedEndpoints.push(endpointId);

        return endpointId === "stage-abcd1234" ? [stageAgent] : [];
      },
    });

    const response = await routeIncomingEvent(
      createZaloEvent(undefined, undefined, "stage-abcd1234"),
      createHandlers({
        handleChannelRequest: async (event) => {
          handledEvents.push(event);
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    await response.afterResponse;

    expect(listedEndpoints).toEqual(["stage-abcd1234"]);
    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]!.agentId).toBe("agent_zzz");
  });

  it("does not fall back to the account scan when a stage webhook URL is unknown", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => ZALO_AGENT,
      // An endpointId from another account resolves empty upstream. Falling
      // back here would hand that traffic to whoever the account scan picked.
      agentLister: async () => [ZALO_AGENT],
      stageAgentLister: async () => [],
    });

    const response = await routeIncomingEvent(
      createZaloEvent(undefined, undefined, "stage-someoneelse"),
      createHandlers(),
    );

    expect(response.statusCode).toBe(404);
    expect(responseJson(response)).toMatchObject({
      error: { code: "unknown_webhook_stage" },
    });
  });

  it("still rejects the retired agent-scoped webhook shape", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => ZALO_AGENT,
      agentLister: async () => [ZALO_AGENT],
    });

    const response = await routeIncomingEvent(
      createTelegramEvent(
        zaloUpdate(),
        { "x-bot-api-secret-token": "zalo-secret" },
        "/v1/webhooks/acct_test/agent_test/zalo",
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(404);
    expect(responseJson(response)).toEqual({
      error: {
        message: expect.any(String),
        type: "not_found_error",
        code: "unknown_webhook_url",
      },
    });
  });

  it("declines a webhook path whose segments are not decodable", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => ZALO_AGENT,
      agentLister: async () => [ZALO_AGENT],
    });

    const response = await routeIncomingEvent(
      createTelegramEvent(zaloUpdate(), undefined, "/v1/webhooks/%ZZ/zalo"),
      createHandlers(),
    );

    expect(response.statusCode).toBe(404);
    expect(responseJson(response)).toMatchObject({
      error: { code: "unknown_webhook_url" },
    });
  });

  // An omitted list still means "everywhere". An empty one is now the explicit
  // deny-all a declared-nothing connection compiles to.
  it("accepts a Zalo sender when allowedUserIds is omitted and denies when it is empty", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    for (const allowedUserIds of [undefined, []]) {
      const zaloAgent = {
        ...ZALO_AGENT,
        config: {
          channels: {
            zalo: {
              botToken: "zalo-token",
              webhookSecret: "zalo-secret",
              allowedUserIds: allowedUserIds,
            },
          },
        },
      };
      const routeIncomingEvent = createIncomingEventRouter({
        accountLoader: async () => TEST_ACCOUNT,
        agentLoader: async () => zaloAgent,
        agentLister: async () => [zaloAgent],
      });

      const response = await routeIncomingEvent(
        createZaloEvent(),
        createHandlers({
          handleChannelRequest: async (event) => {
            handledEvents.push(event);
          },
        }),
      );

      expect(response.statusCode).toBe(200);
      await response.afterResponse;
    }
    expect(handledEvents).toHaveLength(1);
  });

  it("returns 503 when Zalo is not configured", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => TEST_AGENT,
      agentLister: async () => [TEST_AGENT],
    });

    const response = await routeIncomingEvent(
      createZaloEvent(),
      createHandlers(),
    );

    expect(response.statusCode).toBe(503);
    expect(responseJson(response)).toMatchObject({
      error: { message: "zalo integration is not configured" },
    });
  });

  it("answers Meta's GET handshake through the WhatsApp credential holder", async () => {
    const whatsAppAgent = {
      ...TEST_AGENT,
      config: {
        channels: {
          whatsapp: {
            accessToken: "wa-token",
            appSecret: "wa-app-secret",
            phoneNumberId: "phone-1",
            verifyToken: "wa-verify-token",
          },
        },
      },
    };
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => whatsAppAgent,
      agentLister: async () => [whatsAppAgent],
    });
    const handshake = (token: string): ReturnType<typeof coreRequest> =>
      coreRequest(
        "GET",
        `/v1/webhooks/acct_test/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`,
      );

    const accepted = await routeIncomingEvent(
      handshake("wa-verify-token"),
      createHandlers(),
    );
    const refused = await routeIncomingEvent(
      handshake("wrong"),
      createHandlers(),
    );

    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toBe("1158201444");
    expect(refused.statusCode).toBe(401);
  });

  it("admits every message of one batched WhatsApp delivery as its own run", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => WHATSAPP_AGENT,
      agentLister: async () => [WHATSAPP_AGENT],
    });

    const response = await routeIncomingEvent(
      createWhatsAppBatchEvent(),
      createHandlers({
        handleChannelRequest: async (event) => {
          handledEvents.push(event);
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    await response.afterResponse;
    expect(
      handledEvents.map((event) => [event.eventId, event.conversationKey]),
    ).toEqual([
      [
        "acct:acct_test:agent:agent_test:whatsapp:wamid.1",
        "acct:acct_test:agent:agent_test:whatsapp:phone-1:15551111111",
      ],
      [
        "acct:acct_test:agent:agent_test:whatsapp:wamid.2",
        "acct:acct_test:agent:agent_test:whatsapp:phone-1:15552222222",
      ],
    ]);
  });

  it("hands each number of a shared Meta app to the agent that owns it", async () => {
    // One Meta app, one app secret, two numbers: both agents verify the POST,
    // and each must run only the messages sent to its own number.
    const firstAgent = { ...WHATSAPP_AGENT, agentId: "agent_aaa" };
    const secondAgent = {
      ...WHATSAPP_AGENT,
      agentId: "agent_bbb",
      config: {
        channels: {
          whatsapp: {
            ...WHATSAPP_AGENT.config.channels.whatsapp,
            phoneNumberId: "phone-2",
          },
        },
      },
    };
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => firstAgent,
      agentLister: async () => [secondAgent, firstAgent],
    });

    const response = await routeIncomingEvent(
      createWhatsAppBatchEvent([
        { phoneNumberId: "phone-1", from: "15551111111", id: "wamid.1" },
        { phoneNumberId: "phone-2", from: "15552222222", id: "wamid.2" },
        // No agent owns this number: ignored, never a 401 Meta would count.
        { phoneNumberId: "phone-3", from: "15553333333", id: "wamid.3" },
      ]),
      createHandlers({
        handleChannelRequest: async (event) => {
          handledEvents.push(event);
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    await response.afterResponse;
    expect(
      handledEvents
        .map((event) => [event.agentId, event.eventId])
        .sort(([left], [right]) => left!.localeCompare(right!)),
    ).toEqual([
      ["agent_aaa", "acct:acct_test:agent:agent_aaa:whatsapp:wamid.1"],
      ["agent_bbb", "acct:acct_test:agent:agent_bbb:whatsapp:wamid.2"],
    ]);
  });

  it("hands each Page of a shared Meta app to the agent that owns it, once", async () => {
    // One Meta app, one app secret, two Pages: both agents verify the POST and
    // each learns its own Page from its token.
    stubPageLookup({ "fb-token-a": "page-a", "fb-token-b": "page-b" });
    const firstAgent = messengerAgent("agent_aaa", "fb-token-a");
    const secondAgent = messengerAgent("agent_bbb", "fb-token-b");
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => firstAgent,
      agentLister: async () => [secondAgent, firstAgent],
    });

    const response = await routeIncomingEvent(
      createMessengerEvent([
        { pageId: "page-a", psid: "psid-1", mid: "mid.1" },
        { pageId: "page-b", psid: "psid-2", mid: "mid.2" },
        // No agent owns this Page: ignored, never a 401 Meta would count.
        { pageId: "page-c", psid: "psid-3", mid: "mid.3" },
      ]),
      createHandlers({
        handleChannelRequest: async (event) => {
          handledEvents.push(event);
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    await response.afterResponse;
    expect(
      handledEvents
        .map((event) => [event.agentId, event.eventId])
        .sort(([left], [right]) => left!.localeCompare(right!)),
    ).toEqual([
      ["agent_aaa", "acct:acct_test:agent:agent_aaa:messenger:psid-1:mid.1"],
      ["agent_bbb", "acct:acct_test:agent:agent_bbb:messenger:psid-2:mid.2"],
    ]);
  });

  it("admits two messages to one Page as two runs", async () => {
    stubPageLookup({ "fb-token-one": "page-one" });
    const agent = messengerAgent("agent_test", "fb-token-one");
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => agent,
      agentLister: async () => [agent],
    });

    const response = await routeIncomingEvent(
      createMessengerEvent([
        { pageId: "page-one", psid: "psid-1", mid: "mid.1" },
        { pageId: "page-one", psid: "psid-2", mid: "mid.2" },
      ]),
      createHandlers({
        handleChannelRequest: async (event) => {
          handledEvents.push(event);
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    await response.afterResponse;
    expect(handledEvents.map((event) => event.conversationKey)).toEqual([
      "acct:acct_test:agent:agent_test:messenger:page-one:psid-1",
      "acct:acct_test:agent:agent_test:messenger:page-one:psid-2",
    ]);
  });

  it("still gives a delivery to one agent when two share a channel app", async () => {
    // Zalo, like Slack, carries no per-entry owner, so both answering would
    // mean two replies to one message. The lowest agentId takes it.
    const firstAgent = { ...ZALO_AGENT, agentId: "agent_aaa" };
    const secondAgent = { ...ZALO_AGENT, agentId: "agent_bbb" };
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => firstAgent,
      agentLister: async () => [secondAgent, firstAgent],
    });

    const response = await routeIncomingEvent(
      createZaloEvent(),
      createHandlers({
        handleChannelRequest: async (event) => {
          handledEvents.push(event);
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    await response.afterResponse;
    expect(handledEvents.map((event) => event.agentId)).toEqual(["agent_aaa"]);
  });

  it("still admits the rest of a WhatsApp batch when one admission fails", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => WHATSAPP_AGENT,
      agentLister: async () => [WHATSAPP_AGENT],
    });

    const response = await routeIncomingEvent(
      createWhatsAppBatchEvent(),
      createHandlers({
        handleChannelRequest: async (event) => {
          if (event.eventId.endsWith("wamid.1")) {
            throw new Error("admission failed");
          }
          handledEvents.push(event);
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    await response.afterResponse;
    expect(handledEvents.map((event) => event.eventId)).toEqual([
      "acct:acct_test:agent:agent_test:whatsapp:wamid.2",
    ]);
  });

  it("answers a GET no channel claims as live, query string or not", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => PANCAKE_AGENT,
      agentLister: async () => [PANCAKE_AGENT],
    });

    const response = await routeIncomingEvent(
      coreRequest(
        "GET",
        "/v1/webhooks/acct_test/pancake?secret=pancake-secret",
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(200);
    expect(responseJson(response)).toEqual({ status: "ok", method: "POST" });
  });

  it("uses account webhook routing only; root provider webhooks are not accepted", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => TEST_AGENT,
      agentLister: async () => [TEST_AGENT],
      authResolver: async () => null,
    });

    const response = await routeIncomingEvent(
      createTelegramEvent(undefined, undefined, "/"),
      createHandlers(),
    );

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toMatchObject({
      error: { message: "Unauthorized" },
    });
  });

  it("answers Meta's GET handshake through the Messenger credential holder", async () => {
    const messengerAgent = {
      ...TEST_AGENT,
      config: {
        channels: {
          messenger: {
            appSecret: "fb-app-secret",
            pageAccessToken: "fb-page-token",
            verifyToken: "fb-verify-token",
          },
        },
      },
    };
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => messengerAgent,
      agentLister: async () => [messengerAgent],
    });
    const get = (query: string): ReturnType<typeof coreRequest> =>
      coreRequest("GET", `/v1/webhooks/acct_test/messenger${query}`);

    const accepted = await routeIncomingEvent(
      get(
        "?hub.mode=subscribe&hub.verify_token=fb-verify-token&hub.challenge=77",
      ),
      createHandlers(),
    );
    const refused = await routeIncomingEvent(
      get("?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=77"),
      createHandlers(),
    );
    const live = await routeIncomingEvent(get(""), createHandlers());

    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toBe("77");
    expect(refused.statusCode).toBe(401);
    expect(live.statusCode).toBe(200);
    expect(responseJson(live)).toEqual({ status: "ok", method: "POST" });
  });

  it("verifies Twilio's signature over the public webhook URL", async () => {
    const originalBaseUrl = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "https://gateway.broods.test/";
    const twilioAgent = {
      ...TEST_AGENT,
      config: {
        channels: {
          twilio: { accountSid: "AC1", authToken: "twilio-auth-token" },
        },
      },
    };
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => twilioAgent,
      agentLister: async () => [twilioAgent],
    });
    const handledEvents: ChannelInboundEvent[] = [];
    const form = new URLSearchParams({
      Body: "hello",
      From: "+15551234567",
      MessageSid: "SM1",
      NumMedia: "0",
      To: "+15550001111",
    });
    const signature = twilioSignature(
      "https://gateway.broods.test/v1/webhooks/acct_test/twilio",
      form,
    );
    const send = (sig: string): ReturnType<typeof routeIncomingEvent> =>
      routeIncomingEvent(
        coreRequest(
          "POST",
          "/v1/webhooks/acct_test/twilio",
          {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": sig,
          },
          form.toString(),
        ),
        createHandlers({
          handleChannelRequest: async (event) => {
            handledEvents.push(event);
          },
        }),
      );

    try {
      const accepted = await send(signature);
      await accepted.afterResponse;
      const refused = await send("forged");

      expect(accepted.statusCode).toBe(200);
      expect(accepted.body).toBe("<Response></Response>");
      expect(handledEvents).toHaveLength(1);
      expect(refused.statusCode).toBe(401);
    } finally {
      if (originalBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = originalBaseUrl;
    }
  });

  it("hands a Twilio message to the agent that owns the number texted", async () => {
    const originalBaseUrl = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = "https://gateway.broods.test";
    // Two numbers on one Twilio account share its auth token, so both agents
    // verify every delivery.
    const numberAgent = (agentId: string, phoneNumber: string) => ({
      ...TEST_AGENT,
      agentId: agentId,
      config: {
        channels: {
          twilio: {
            accountSid: "AC1",
            authToken: "twilio-auth-token",
            phoneNumber: phoneNumber,
          },
        },
      },
    });
    const agents = [
      numberAgent("agent_a", "+15550000001"),
      numberAgent("agent_b", "+15550000002"),
    ];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async (_accountId, agentId) =>
        agents.find((agent) => agent.agentId === agentId) ?? null,
      agentLister: async () => agents,
    });
    const handledEvents: ChannelInboundEvent[] = [];
    const form = new URLSearchParams({
      Body: "hello b",
      From: "+15551234567",
      MessageSid: "SM2",
      NumMedia: "0",
      To: "+15550000002",
    });

    try {
      const response = await routeIncomingEvent(
        coreRequest(
          "POST",
          "/v1/webhooks/acct_test/twilio",
          {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": twilioSignature(
              "https://gateway.broods.test/v1/webhooks/acct_test/twilio",
              form,
            ),
          },
          form.toString(),
        ),
        createHandlers({
          handleChannelRequest: async (event) => {
            handledEvents.push(event);
          },
        }),
      );
      await response.afterResponse;

      expect(response.statusCode).toBe(200);
      expect(handledEvents.map((event) => event.agentId)).toEqual(["agent_b"]);
    } finally {
      if (originalBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = originalBaseUrl;
    }
  });
});

// Twilio's scheme: the URL, then every field name and value in name order,
// HMAC-SHA1 with the auth token, base64.
function twilioSignature(url: string, form: URLSearchParams): string {
  return createHmac("sha1", "twilio-auth-token")
    .update(
      `${url}${[...form]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([name, value]) => `${name}${value}`)
        .join("")}`,
    )
    .digest("base64");
}

function createHandlers(
  overrides: Partial<{
    handleDirectRequest(event: DirectInboundEvent): Promise<ResponseShape>;
    handleChannelRequest(event: ChannelInboundEvent): Promise<void>;
  }> = {},
): {
  handleDirectRequest: (event: DirectInboundEvent) => Promise<Response>;
  handleChannelRequest: (event: ChannelInboundEvent) => Promise<void>;
} {
  return {
    handleDirectRequest: async (event: DirectInboundEvent) =>
      responseFromShape(
        await (overrides.handleDirectRequest ?? defaultDirectHandler)(event),
      ),
    handleChannelRequest: overrides.handleChannelRequest ?? (async () => {}),
  };
}

async function defaultDirectHandler(): Promise<ResponseShape> {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: "ok",
  };
}

function createIncomingEventRouter(
  options: IntegrationRoutingOptions = {},
): (
  request: ReturnType<typeof coreRequest>,
  handlers: ReturnType<typeof createHandlers>,
) => Promise<ResponseShape> {
  return async (
    request: ReturnType<typeof coreRequest>,
    handlers: ReturnType<typeof createHandlers>,
  ): Promise<ResponseShape> => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const router = createCoreIncomingEventRouter({
      deploymentLoader: async () => null,
      // These accounts configure no channel records; without a loader the
      // default reaches the real storage boundary, which these stubs omit.
      channelRecordLoader: async () => null,
      ...options,
      waitUntil: (promise) => {
        waitUntilPromises.push(Promise.resolve(promise));
        options.waitUntil?.(promise);
      },
    });
    const response = await router(request, handlers);
    const shape = await responseToShape(response);
    if (waitUntilPromises.length > 0) {
      shape.afterResponse = Promise.all(waitUntilPromises).then(
        () => undefined,
      );
    }

    return shape;
  };
}

function createPancakeEvent(): ReturnType<typeof coreRequest> {
  return createTelegramEvent(
    {
      page_id: "page-1",
      event_type: "messaging",
      data: {
        conversation: {
          id: "conversation-1",
          type: "INBOX",
          tags: [],
          from: { id: "customer-1", name: "Ada" },
        },
        message: {
          id: "message-1",
          conversation_id: "conversation-1",
          page_id: "page-1",
          message: "hello pancake",
          type: "INBOX",
          from: {
            id: "customer-1",
            name: "Ada",
            page_customer_id: "page-customer-1",
          },
        },
      },
    },
    {
      "content-type": "application/json",
    },
    "/v1/webhooks/acct_test/pancake",
    "secret=pancake-secret",
  );
}

// One signed Meta delivery, one entry per message. By default two customers
// writing to `phone-1`.
function createWhatsAppBatchEvent(
  messages: { phoneNumberId: string; from: string; id: string }[] = [
    { phoneNumberId: "phone-1", from: "15551111111", id: "wamid.1" },
    { phoneNumberId: "phone-1", from: "15552222222", id: "wamid.2" },
  ],
): ReturnType<typeof coreRequest> {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: messages.map((message) => ({
      id: "waba-1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: message.phoneNumberId },
            contacts: [
              { profile: { name: message.from }, wa_id: message.from },
            ],
            messages: [
              {
                from: message.from,
                id: message.id,
                timestamp: "1713916800",
                type: "text",
                text: { body: `hello from ${message.from}` },
              },
            ],
          },
        },
      ],
    })),
  });
  const signature = createHmac("sha256", "wa-app-secret")
    .update(body)
    .digest("hex");

  return coreRequest(
    "POST",
    "/v1/webhooks/acct_test/whatsapp",
    { "x-hub-signature-256": `sha256=${signature}` },
    body,
  );
}

// One signed Messenger delivery, one entry per message, all under one app.
function createMessengerEvent(
  messages: { pageId: string; psid: string; mid: string }[],
): ReturnType<typeof coreRequest> {
  const body = JSON.stringify({
    object: "page",
    entry: messages.map((message) => ({
      id: message.pageId,
      time: 1_760_000_000_000,
      messaging: [
        {
          sender: { id: message.psid },
          recipient: { id: message.pageId },
          timestamp: 1_760_000_000_000,
          message: { mid: message.mid, text: `hello from ${message.psid}` },
        },
      ],
    })),
  });
  const signature = createHmac("sha256", "fb-app-secret")
    .update(body)
    .digest("hex");

  return coreRequest(
    "POST",
    "/v1/webhooks/acct_test/messenger",
    { "x-hub-signature-256": `sha256=${signature}` },
    body,
  );
}

function createZaloEvent(
  body: unknown = zaloUpdate(),
  headers: Record<string, string> = {
    "x-bot-api-secret-token": "zalo-secret",
  },
  endpointId?: string,
): ReturnType<typeof coreRequest> {
  const path = endpointId
    ? `/v1/webhooks/acct_test/dev/${endpointId}/zalo`
    : "/v1/webhooks/acct_test/zalo";

  return createTelegramEvent(body, headers, path);
}

function createTelegramEvent(
  body: unknown = telegramUpdate(),
  headers: Record<string, string> = {
    "x-telegram-bot-api-secret-token": TELEGRAM_WEBHOOK_SECRET,
  },
  rawPath = "/v1/webhooks/acct_test/telegram",
  rawQueryString = "",
): ReturnType<typeof coreRequest> {
  return coreRequest(
    "POST",
    rawQueryString ? `${rawPath}?${rawQueryString}` : rawPath,
    headers,
    body,
  );
}

// Graph answers `/me` with the Page each access token belongs to.
function stubPageLookup(pages: Record<string, string>): void {
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      const page = pages[url.searchParams.get("access_token") ?? ""];

      return page
        ? Response.json({ id: page })
        : Response.json(
            { error: { message: "unknown token" } },
            { status: 400 },
          );
    },
    { preconnect: ORIGINAL_FETCH.preconnect },
  );
}

function telegramUpdate(): {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    text: string;
    chat: { id: number; type: string };
    from: { id: number; is_bot: boolean; username: string };
  };
} {
  return {
    update_id: 7,
    message: {
      message_id: 9,
      date: 1713916800,
      text: "hello",
      chat: { id: 123, type: "private" },
      from: { id: 456, is_bot: false, username: "alice" },
    },
  };
}

function zaloUpdate(): {
  event_name: string;
  message: {
    message_id: string;
    date: number;
    text: string;
    chat: { id: string; chat_type: string };
    from: { id: string; name: string; is_bot: boolean };
  };
} {
  return {
    event_name: "message.text.received",
    message: {
      message_id: "message-1",
      date: 1713916800,
      text: "hello zalo",
      chat: { id: "chat-1", chat_type: "PRIVATE" },
      from: { id: "user-1", name: "Ada", is_bot: false },
    },
  };
}

interface ResponseShape {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  afterResponse?: Promise<void>;
}

function messengerAgent(agentId: string, pageAccessToken: string): AgentRecord {
  return {
    ...TEST_AGENT,
    agentId: agentId,
    config: {
      channels: {
        messenger: {
          appSecret: "fb-app-secret",
          pageAccessToken: pageAccessToken,
          verifyToken: "fb-verify-token",
        },
      },
    },
  };
}

function responseJson(response: { body?: unknown }): Record<string, unknown> {
  if (typeof response.body !== "string") {
    throw new Error("Expected JSON response body to be a string");
  }

  return JSON.parse(response.body) as Record<string, unknown>;
}

function responseFromShape(response: ResponseShape): Response {
  return new Response(response.body, {
    status: response.statusCode,
    headers: response.headers,
  });
}

async function responseToShape(response: Response): Promise<ResponseShape> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: response.status,
    headers: headers,
    body: await response.text(),
  };
}
