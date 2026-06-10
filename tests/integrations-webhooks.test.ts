import { afterEach, describe, expect, it, mock } from "bun:test";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import {
  createIncomingEventRouter,
  type ChannelInboundEvent,
  type DirectInboundEvent,
} from "../functions/harness-processing/integrations.ts";

const TEST_ACCOUNT = {
  accountId: "acct_test",
  username: "test-account",
  description: "Test account",
  secretHash: "hash",
  status: "active" as const,
  config: {
    channels: {
      telegram: {
        botToken: "bot-token",
        webhookSecret: "telegram-secret",
        allowedChatIds: [123],
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
        options: {
          ignoreTagIds: ["order-tag", "pending-tag"],
        },
      },
    },
  },
};

const PANCAKE_HANDOFF_AGENT = {
  ...PANCAKE_AGENT,
  config: {
    channels: {
      pancake: {
        pageId: "page-1",
        pageAccessToken: "page-token",
        webhookSecret: "pancake-secret",
        options: {
          ignoreTagIds: ["order-tag", "pending-tag"],
        },
      },
    },
    tools: {
      handoffs: {
        enabled: true,
        pancake: {
          scenarioTagIds: {
            order: "order-tag",
            pending: "pending-tag",
          },
        },
        zalo: {
          botToken: "zalo-token",
          notifyUserIds: ["sale-1"],
        },
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

const ORIGINAL_FETCH = globalThis.fetch;

describe("account webhook ingress", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("returns 404 for unknown accounts", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => null,
    });

    const response = await routeIncomingEvent(createTelegramEvent(), createHandlers());

    expect(response.statusCode).toBe(404);
    expect(responseJson(response)).toEqual({ error: "Not found" });
  });

  it("returns 503 when the account has not configured the requested channel", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => ({
        ...TEST_ACCOUNT,
      }),
      agentLoader: async () => ({ ...TEST_AGENT, config: {} }),
    });

    const response = await routeIncomingEvent(createTelegramEvent(), createHandlers());

    expect(response.statusCode).toBe(503);
    expect(responseJson(response)).toEqual({ error: "telegram integration is not configured" });
  });

  it("returns 401 when account channel authentication fails", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => TEST_AGENT,
    });

    const response = await routeIncomingEvent(createTelegramEvent(undefined, {
      "x-telegram-bot-api-secret-token": "wrong",
    }), createHandlers());

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when Zalo webhook authentication is missing or wrong", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => ZALO_AGENT,
    });

    const missing = await routeIncomingEvent(createZaloEvent(undefined, {}), createHandlers());
    expect(missing.statusCode).toBe(401);
    expect(responseJson(missing)).toEqual({ error: "Unauthorized" });

    const wrong = await routeIncomingEvent(createZaloEvent(undefined, {
      "x-bot-api-secret-token": "wrong-secret",
    }), createHandlers());
    expect(wrong.statusCode).toBe(401);
    expect(responseJson(wrong)).toEqual({ error: "Unauthorized" });
  });

  it("normalizes account webhook events and schedules channel processing", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => TEST_AGENT,
    });

    const response = await routeIncomingEvent(createTelegramEvent(), createHandlers({
      handleChannelRequest: async (event) => {
        handledEvents.push(event);
      },
    }));

    expect(response.statusCode).toBe(200);
    expect(response.afterResponse).toBeDefined();

    await response.afterResponse;

    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]).toMatchObject({
      accountId: "acct_test",
      agentId: "agent_test",
      agentConfig: {
        channels: {
          telegram: {
            botToken: "bot-token",
            webhookSecret: "telegram-secret",
            allowedChatIds: [123],
          },
        },
      },
      eventId: "acct:acct_test:agent:agent_test:tg:7",
      conversationKey: "acct:acct_test:agent:agent_test:tg:123",
      content: "hello",
      events: [{ role: "user", content: "hello" }],
      channelName: "telegram",
    });
  });

  it("normalizes Pancake webhook events through account webhook routing", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => PANCAKE_AGENT,
    });

    const response = await routeIncomingEvent(createPancakeEvent(), createHandlers({
      handleChannelRequest: async (event) => {
        handledEvents.push(event);
      },
    }));

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
        },
      },
      conversationKey: "acct:acct_test:agent:agent_test:pancake:page-1:conversation-1",
      content: [{ type: "text", text: "hello pancake" }],
      events: [{ role: "user", content: [{ type: "text", text: "hello pancake" }] }],
      channelName: "pancake",
    });
    expect(handledEvents[0]!.eventId.startsWith("acct:acct_test:agent:agent_test:pancake:page-1:message-1:"))
      .toBe(true);
  });

  it("normalizes Zalo webhook events through account webhook routing", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => ZALO_AGENT,
    });

    const response = await routeIncomingEvent(createZaloEvent(), createHandlers({
      handleChannelRequest: async (event) => {
        handledEvents.push(event);
      },
    }));

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
      eventId: "acct:acct_test:agent:agent_test:zalo:message.text.received:chat-1:user-1:message-1",
      conversationKey: "acct:acct_test:agent:agent_test:zalo:chat-1",
      content: "hello zalo",
      events: [{ role: "user", content: "hello zalo" }],
      channelName: "zalo",
    });
  });

  it("returns 503 when Zalo is not configured", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => TEST_AGENT,
    });

    const response = await routeIncomingEvent(createZaloEvent(), createHandlers());

    expect(response.statusCode).toBe(503);
    expect(responseJson(response)).toEqual({ error: "zalo integration is not configured" });
  });

  it("lets Pancake scenario handoff tags ignore human-owned conversations", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    globalThis.fetch = mock(async () => {
      throw new Error("Pancake handoff tag check should not call fetch");
    }) as never;
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => PANCAKE_HANDOFF_AGENT,
    });

    const response = await routeIncomingEvent(createPancakeEvent({
      conversation: { tags: ["pending-tag"] },
    }), createHandlers({
      handleChannelRequest: async (event) => {
        handledEvents.push(event);
      },
    }));

    expect(response.statusCode).toBe(200);
    expect(response.afterResponse).toBeUndefined();
    expect(handledEvents).toHaveLength(0);
  });

  it("uses account webhook routing only; root provider webhooks are not accepted", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
      agentLoader: async () => TEST_AGENT,
      authResolver: async () => null,
    });

    const response = await routeIncomingEvent(createTelegramEvent(undefined, undefined, "/"), createHandlers());

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
  });

});

function createHandlers(overrides: Partial<{
  handleDirectRequest(event: DirectInboundEvent): Promise<ResponseShape>;
  handleChannelRequest(event: ChannelInboundEvent): Promise<void>;
}> = {}) {
  return {
    handleDirectRequest: overrides.handleDirectRequest ?? (async () => ({
      statusCode: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "ok",
    })),
    handleChannelRequest: overrides.handleChannelRequest ?? (async () => { }),
  };
}

function createPancakeEvent(overrides: {
  conversation?: Record<string, unknown>;
  message?: Record<string, unknown>;
} = {}): LambdaFunctionURLEvent {
  return createTelegramEvent({
    page_id: "page-1",
    event_type: "messaging",
    data: {
      conversation: {
        id: "conversation-1",
        type: "INBOX",
        tags: [],
        from: { id: "customer-1", name: "Ada" },
        ...overrides.conversation,
      },
      message: {
        id: "message-1",
        conversation_id: "conversation-1",
        page_id: "page-1",
        message: "hello pancake",
        type: "INBOX",
        from: { id: "customer-1", name: "Ada", page_customer_id: "page-customer-1" },
        ...overrides.message,
      },
    },
  }, {
    "content-type": "application/json",
  }, "/webhooks/acct_test/agent_test/pancake", "secret=pancake-secret");
}

function createZaloEvent(
  body: unknown = zaloUpdate(),
  headers: Record<string, string> = {
    "x-bot-api-secret-token": "zalo-secret",
  },
): LambdaFunctionURLEvent {
  return createTelegramEvent(body, headers, "/webhooks/acct_test/agent_test/zalo");
}

function createTelegramEvent(
  body: unknown = telegramUpdate(),
  headers: Record<string, string> = {
    "x-telegram-bot-api-secret-token": "telegram-secret",
  },
  rawPath = "/webhooks/acct_test/agent_test/telegram",
  rawQueryString = "",
): LambdaFunctionURLEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString,
    headers,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "example.lambda-url.aws",
      domainPrefix: "example",
      http: {
        method: "POST",
        path: rawPath,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "bun:test",
      },
      requestId: "request-id",
      routeKey: "$default",
      stage: "$default",
      time: "24/Apr/2026:00:00:00 +0000",
      timeEpoch: Date.now(),
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function telegramUpdate() {
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

function zaloUpdate() {
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
}

function responseJson(response: { body?: unknown }): Record<string, unknown> {
  if (typeof response.body !== "string") {
    throw new Error("Expected JSON response body to be a string");
  }

  return JSON.parse(response.body) as Record<string, unknown>;
}
