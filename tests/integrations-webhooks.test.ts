import { describe, expect, it } from "bun:test";
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

describe("account webhook ingress", () => {
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
        config: {},
      }),
    });

    const response = await routeIncomingEvent(createTelegramEvent(), createHandlers());

    expect(response.statusCode).toBe(503);
    expect(responseJson(response)).toEqual({ error: "telegram integration is not configured" });
  });

  it("returns 401 when account channel authentication fails", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
    });

    const response = await routeIncomingEvent(createTelegramEvent(undefined, {
      "x-telegram-bot-api-secret-token": "wrong",
    }), createHandlers());

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("normalizes account webhook events and schedules channel processing", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
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
      accountConfig: {},
      eventId: "acct:acct_test:tg-7",
      conversationKey: "acct:acct_test:tg:123",
      content: "hello",
      events: [{ role: "user", content: "hello" }],
      channelName: "telegram",
    });
  });

  it("uses account webhook routing only; root provider webhooks are not accepted", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      accountLoader: async () => TEST_ACCOUNT,
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

function createTelegramEvent(
  body: unknown = telegramUpdate(),
  headers: Record<string, string> = {
    "x-telegram-bot-api-secret-token": "telegram-secret",
  },
  rawPath = "/webhooks/acct_test/telegram",
): LambdaFunctionURLEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
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
