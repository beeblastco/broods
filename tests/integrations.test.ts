import { describe, expect, it } from "bun:test";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import type { LambdaResponse } from "../functions/_shared/runtime.ts";
import {
  createIncomingEventRouter,
  type AsyncDirectInboundEvent,
  type ChannelInboundEvent,
  type DirectInboundEvent,
  type StatusInboundEvent,
} from "../functions/harness-processing/integrations.ts";

const TEST_ACCOUNT = {
  accountId: "acct_test",
  username: "test-account",
  description: "Test account",
  secretHash: "hash",
  status: "active" as const,
  config: {
    modelId: "gemini-test",
    memoryNamespace: "support",
    channels: {
      slack: {
        botToken: "xoxb-secret",
        signingSecret: "signing-secret",
      },
    },
  },
  createdAt: "2026-04-24T00:00:00.000Z",
  updatedAt: "2026-04-24T00:00:00.000Z",
};

describe("direct API ingress", () => {

  it("returns 401 when the account bearer token is missing", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    }), createHandlers());

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("returns 200 for GET probes without requiring direct API configuration", async () => {
    const response = await routeIncomingEvent(createEvent(undefined, {}, {
      method: "GET",
    }), createHandlers());

    expect(response.statusCode).toBe(200);
    expect(responseJson(response)).toEqual({ status: "ok", method: "POST" });
  });

  it("returns 405 for unsupported request methods", async () => {
    const response = await routeIncomingEvent(createEvent(undefined, {}, {
      method: "PUT",
    }), createHandlers());

    expect(response.statusCode).toBe(405);
    expect(responseJson(response)).toEqual({
      error: "Method not allowed",
      method: "PUT",
      allowedMethods: ["GET", "POST"],
    });
  });

  it("returns 401 when the bearer token is missing", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    }), createHandlers());

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when the bearer token is malformed", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    }, {
      authorization: "Bearer secret extra",
    }), createHandlers());

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when the bearer token does not match", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    }, {
      authorization: "Bearer secrets",
    }), createHandlers());

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("returns 400 for invalid direct API JSON", async () => {
    const response = await routeIncomingEvent(createEvent(undefined, {
      authorization: "Bearer secret",
    }, {
      rawBody: "{",
    }), createHandlers());

    expect(response.statusCode).toBe(400);
    expect(responseJson(response).error).toContain("Invalid request JSON:");
  });

  it("returns 400 when eventId or conversationKey is missing", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    }, {
      authorization: "Bearer secret",
    }), createHandlers());

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({ error: "Request body must include eventId and conversationKey" });
  });

  it("rejects reserved direct event prefixes", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "gh:issue",
      conversationKey: "alpha",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    }, {
      authorization: "Bearer secret",
    }), createHandlers());

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({ error: "eventId uses a reserved internal prefix" });
  });

  it("rejects reserved direct conversation prefixes", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "gh:owner/repo:issue:1",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    }, {
      authorization: "Bearer secret",
    }), createHandlers());

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({ error: "conversationKey uses a reserved channel or internal prefix" });
  });

  it("returns 400 when the events field is not an array", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: "hello",
    }, {
      authorization: "Bearer secret",
    }), createHandlers());

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({ error: "Request body field 'events' must be an array" });
  });

  it("returns 400 when the events array is empty", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: [],
    }, {
      authorization: "Bearer secret",
    }), createHandlers());

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({ error: "Request body must include a non-empty events array" });
  });

  it("returns 400 when a direct event is not an object", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: ["hello"],
    }, {
      authorization: "Bearer secret",
    }), createHandlers());

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({ error: "Each direct event must be an object" });
  });

  it("returns 400 when persist is set on a non-system event", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
        persist: false,
      }],
    }, {
      authorization: "Bearer secret",
    }), createHandlers());

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({ error: "Only system-role events may set persist" });
  });

  it("rejects persisted system events", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: [
        {
          role: "system",
          content: "persist me",
          persist: true,
        },
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    }, {
      authorization: "Bearer secret",
    }), createHandlers());

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({ error: "Direct API system events cannot be persisted" });
  });

  it("normalizes direct events before handing them to the application handler", async () => {
    const handledEvents: DirectInboundEvent[] = [];
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: [
        {
          role: "system",
          content: "be brief",
          persist: false,
        },
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    }, {
      authorization: "Bearer secret",
    }), createHandlers({
      handleDirectRequest: async (event) => {
        handledEvents.push(event);
        return {
          statusCode: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: "ok",
        };
      },
    }));

    expect(response.statusCode).toBe(200);
    expect(handledEvents).toHaveLength(1);
    const directEvent = handledEvents[0];
    if (directEvent == null) {
      throw new Error("Expected direct event to be handled");
    }
    expect(directEvent.eventId).toBe("acct:acct_test:api:one");
    expect(directEvent.accountId).toBe("acct_test");
    expect(directEvent.accountConfig).toEqual({
      modelId: "gemini-test",
      memoryNamespace: "support",
    });
    expect(directEvent.publicEventId).toBe("one");
    expect(directEvent.conversationKey).toBe("acct:acct_test:api:alpha");
    expect(directEvent.publicConversationKey).toBe("alpha");
    expect(directEvent.events).toEqual([
      {
        role: "system",
        content: "be brief",
        persist: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ]);
  });

  it("routes async direct API requests with a status URL", async () => {
    const handledEvents: AsyncDirectInboundEvent[] = [];
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    }, {
      authorization: "Bearer secret",
      host: "example.lambda-url.aws",
      "x-forwarded-proto": "https",
    }, {
      rawPath: "/async",
    }), createHandlers({
      handleAsyncRequest: async (event) => {
        handledEvents.push(event);
        return {
          statusCode: 202,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ statusUrl: event.statusUrl }),
        };
      },
    }));

    expect(response.statusCode).toBe(202);
    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]?.eventId).toBe("acct:acct_test:api:one");
    expect(handledEvents[0]?.statusUrl).toBe("https://example.lambda-url.aws/status/one");
  });

  it("parses optional webhook config for direct API requests", async () => {
    const handledEvents: DirectInboundEvent[] = [];
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      webhookUrl: "https://callbacks.example/hook",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    }, {
      authorization: "Bearer secret",
      "x-webhook-secret": "webhook-secret",
    }), createHandlers({
      handleDirectRequest: async (event) => {
        handledEvents.push(event);
        return {
          statusCode: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: "ok",
        };
      },
    }));

    expect(response.statusCode).toBe(200);
    expect(handledEvents[0]?.webhookConfig).toEqual({
      url: "https://callbacks.example/hook",
      secret: "webhook-secret",
    });
  });

  it("rejects webhook URLs without a webhook secret", async () => {
    const response = await routeIncomingEvent(createEvent({
      eventId: "one",
      conversationKey: "alpha",
      webhookUrl: "https://callbacks.example/hook",
      events: [{
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }],
    }, {
      authorization: "Bearer secret",
    }), createHandlers());

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({ error: "X-Webhook-Secret is required when webhookUrl is provided" });
  });

  it("routes status requests through direct API auth", async () => {
    const handledEvents: StatusInboundEvent[] = [];
    const response = await routeIncomingEvent(createEvent(undefined, {
      authorization: "Bearer secret",
    }, {
      method: "GET",
      rawPath: "/status/one",
    }), createHandlers({
      handleStatusRequest: async (event) => {
        handledEvents.push(event);
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "processing" }),
        };
      },
    }));

    expect(response.statusCode).toBe(200);
    expect(handledEvents).toEqual([{ accountId: "acct_test", eventId: "acct:acct_test:api:one", publicEventId: "one" }]);
  });
});

function createHandlers(overrides: Partial<{
  handleDirectRequest(event: DirectInboundEvent): Promise<ResponseShape>;
  handleAsyncRequest(event: AsyncDirectInboundEvent): Promise<ResponseShape>;
  handleStatusRequest(event: StatusInboundEvent): Promise<ResponseShape>;
  handleChannelRequest(event: ChannelInboundEvent): Promise<void>;
}> = {}) {
  return {
    handleDirectRequest: overrides.handleDirectRequest ?? (async () => ({
      statusCode: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "ok",
    })),
    handleAsyncRequest: overrides.handleAsyncRequest,
    handleStatusRequest: overrides.handleStatusRequest,
    handleChannelRequest: overrides.handleChannelRequest ?? (async () => {}),
  };
}

async function routeIncomingEvent(
  event: LambdaFunctionURLEvent,
  handlers: ReturnType<typeof createHandlers>,
): Promise<ResponseShape> {
  const router = createIncomingEventRouter({
    authResolver: async (headers) =>
      headers.authorization === "Bearer secret"
        ? { kind: "account", account: TEST_ACCOUNT }
        : null,
  });

  const response = await router(event, handlers);
  return response as ResponseShape & LambdaResponse;
}

function createEvent(
  body: unknown,
  headers: Record<string, string> = {},
  options: Partial<{
    method: string;
    rawPath: string;
    rawBody: string;
    isBase64Encoded: boolean;
  }> = {},
): LambdaFunctionURLEvent {
  const rawPath = options.rawPath ?? "/";

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
        method: options.method ?? "POST",
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
    body: options.rawBody ?? JSON.stringify(body),
    isBase64Encoded: options.isBase64Encoded ?? false,
  };
}

interface ResponseShape {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

function responseJson(response: ResponseShape): Record<string, unknown> {
  return JSON.parse(response.body ?? "{}") as Record<string, unknown>;
}
