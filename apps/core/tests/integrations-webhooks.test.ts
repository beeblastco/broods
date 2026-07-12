import { afterEach, describe, expect, it } from "bun:test";
import {
  createIncomingEventRouter as createCoreIncomingEventRouter,
  type ChannelInboundEvent,
  type DirectInboundEvent,
  type IntegrationRoutingOptions,
} from "../src/harness/integrations.ts";
import {
  getObservabilityContext,
  setObservabilityContext,
} from "../src/shared/otel.ts";
import { coreRequest } from "./helpers/http.ts";

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
    setObservabilityContext(null);
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
      deploymentLoader: async () => ({
        accountId: "acct_test",
        endpointId: "endpoint-development",
        projectSlug: "project-one",
        environmentSlug: "development",
      }),
    });
    let processingScope: ReturnType<typeof getObservabilityContext> = null;

    const response = await routeIncomingEvent(createTelegramEvent(), createHandlers({
      handleChannelRequest: async (event) => {
        processingScope = getObservabilityContext();
        handledEvents.push(event);
      },
    }));

    expect(response.statusCode).toBe(200);
    expect(response.afterResponse).toBeDefined();

    await response.afterResponse;

    expect(processingScope).toMatchObject({
      accountId: "acct_test",
      endpointId: "endpoint-development",
      project: "project-one",
      environment: "development",
    });
    expect(getObservabilityContext()).toBeNull();
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
      endpointId: "endpoint-development",
      projectSlug: "project-one",
      environmentSlug: "development",
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

  it("accepts Zalo webhook senders when allowedUserIds is omitted or empty", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    for (const allowedUserIds of [undefined, []]) {
      const routeIncomingEvent = createIncomingEventRouter({
        accountLoader: async () => TEST_ACCOUNT,
        agentLoader: async () => ({
          ...ZALO_AGENT,
          config: {
            channels: {
              zalo: {
                botToken: "zalo-token",
                webhookSecret: "zalo-secret",
                allowedUserIds,
              },
            },
          },
        }),
      });

      const response = await routeIncomingEvent(createZaloEvent(), createHandlers({
        handleChannelRequest: async (event) => {
          handledEvents.push(event);
        },
      }));

      expect(response.statusCode).toBe(200);
      await response.afterResponse;
    }
    expect(handledEvents).toHaveLength(2);
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
    handleDirectRequest: async (event: DirectInboundEvent) =>
      responseFromShape(await (overrides.handleDirectRequest ?? defaultDirectHandler)(event)),
    handleChannelRequest: overrides.handleChannelRequest ?? (async () => { }),
  };
}

async function defaultDirectHandler(): Promise<ResponseShape> {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body: "ok",
  };
}

function createIncomingEventRouter(options: IntegrationRoutingOptions = {}) {
  return async (
    request: ReturnType<typeof coreRequest>,
    handlers: ReturnType<typeof createHandlers>,
  ): Promise<ResponseShape> => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const router = createCoreIncomingEventRouter({
      ...options,
      waitUntil: (promise) => {
        waitUntilPromises.push(Promise.resolve(promise));
        options.waitUntil?.(promise);
      },
    });
    const response = await router(request, handlers);
    const shape = await responseToShape(response);
    if (waitUntilPromises.length > 0) {
      shape.afterResponse = Promise.all(waitUntilPromises).then(() => undefined);
    }
    return shape;
  };
}

function createPancakeEvent(): ReturnType<typeof coreRequest> {
  return createTelegramEvent({
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
        from: { id: "customer-1", name: "Ada", page_customer_id: "page-customer-1" },
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
): ReturnType<typeof coreRequest> {
  return createTelegramEvent(body, headers, "/webhooks/acct_test/agent_test/zalo");
}

function createTelegramEvent(
  body: unknown = telegramUpdate(),
  headers: Record<string, string> = {
    "x-telegram-bot-api-secret-token": "telegram-secret",
  },
  rawPath = "/webhooks/acct_test/agent_test/telegram",
  rawQueryString = "",
): ReturnType<typeof coreRequest> {
  return coreRequest(
    "POST",
    rawQueryString ? `${rawPath}?${rawQueryString}` : rawPath,
    headers,
    body,
  );
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
  afterResponse?: Promise<void>;
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
    headers,
    body: await response.text(),
  };
}
