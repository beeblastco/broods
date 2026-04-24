import { describe, expect, it, mock } from "bun:test";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import type {
  ChannelAdapter,
  ChannelRequest,
} from "../functions/_shared/channels.ts";
import {
  createIncomingEventRouter,
  type ChannelInboundEvent,
  type ChannelRegistry,
  type DirectInboundEvent,
} from "../functions/harness-processing/integrations.ts";

describe("webhook ingress", () => {
  it("returns 503 for recognizable unconfigured channel headers", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      channelRegistry: createChannelRegistry(),
    });

    const cases: Array<{
      headers: Record<string, string>;
      expectedBody: string;
    }> = [
      {
        headers: { "x-telegram-bot-api-secret-token": "secret" },
        expectedBody: "Telegram integration is not configured",
      },
      {
        headers: { "x-github-event": "issues" },
        expectedBody: "GitHub integration is not configured",
      },
      {
        headers: { "x-slack-signature": "v0=test" },
        expectedBody: "Slack integration is not configured",
      },
      {
        headers: { "x-signature-ed25519": "signature" },
        expectedBody: "Discord integration is not configured",
      },
    ];

    for (const testCase of cases) {
      const response = await routeIncomingEvent(createEvent({}, testCase.headers), createHandlers());
      expect(response.statusCode).toBe(503);
      expect(response.body).toBe(testCase.expectedBody);
    }
  });

  it("returns 401 when a matched adapter rejects authentication", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      channelRegistry: createChannelRegistry({
        webhookChannels: [createAdapter({
          authenticate: async () => false,
        })],
      }),
    });

    const response = await routeIncomingEvent(createEvent({}, {
      "x-test-channel": "yes",
    }), createHandlers());

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe("Unauthorized");
  });

  it("passes through adapter response payloads", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      channelRegistry: createChannelRegistry({
        webhookChannels: [createAdapter({
          parse: () => ({
            kind: "response",
            response: {
              statusCode: 202,
              headers: { "x-test-response": "accepted" },
              body: "accepted",
            },
          }),
        })],
      }),
    });

    const response = await routeIncomingEvent(createEvent({}, {
      "x-test-channel": "yes",
    }), createHandlers());

    expect(response.statusCode).toBe(202);
    expect(response.headers).toEqual({ "x-test-response": "accepted" });
    expect(response.body).toBe("accepted");
  });

  it("passes through ignored webhook responses and defaults ignored events to 200", async () => {
    const routeIgnored = createIncomingEventRouter({
      channelRegistry: createChannelRegistry({
        webhookChannels: [createAdapter({
          parse: () => ({ kind: "ignore" }),
        })],
      }),
    });

    const defaultResponse = await routeIgnored(createEvent({}, {
      "x-test-channel": "yes",
    }), createHandlers());

    expect(defaultResponse.statusCode).toBe(200);
    expect(defaultResponse.body).toBe("");

    const routeIgnoredWithResponse = createIncomingEventRouter({
      channelRegistry: createChannelRegistry({
        webhookChannels: [createAdapter({
          parse: () => ({
            kind: "ignore",
            response: {
              statusCode: 204,
              body: "ignored",
            },
          }),
        })],
      }),
    });

    const explicitResponse = await routeIgnoredWithResponse(createEvent({}, {
      "x-test-channel": "yes",
    }), createHandlers());

    expect(explicitResponse.statusCode).toBe(204);
    expect(explicitResponse.body).toBe("ignored");
  });

  it("normalizes channel events, prefers inline commands, and schedules afterResponse work", async () => {
    const handledEvents: ChannelInboundEvent[] = [];
    const sendTyping = mock(async () => {});
    const reactToMessage = mock(async () => {});

    const routeIncomingEvent = createIncomingEventRouter({
      channelRegistry: createChannelRegistry({
        webhookChannels: [createAdapter({
          parse: () => ({
            kind: "message",
            message: {
              eventId: "evt-1",
              conversationKey: "conv-1",
              channelName: "test",
              content: "/help explain this",
              source: {
                commandToken: "/new",
                raw: true,
              },
            },
            ack: {
              statusCode: 202,
              headers: { "x-test-ack": "queued" },
              body: "queued",
            },
          }),
          actions: () => ({
            sendText: async () => {},
            sendTyping,
            reactToMessage,
          }),
        })],
      }),
    });

    const response = await routeIncomingEvent(createEvent({}, {
      "x-test-channel": "yes",
    }), createHandlers({
      handleChannelRequest: async (event) => {
        handledEvents.push(event);
      },
    }));

    expect(response.statusCode).toBe(202);
    expect(response.headers).toEqual({ "x-test-ack": "queued" });
    expect(response.body).toBe("queued");
    expect(response.afterResponse).toBeDefined();

    await response.afterResponse;

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(reactToMessage).toHaveBeenCalledTimes(1);
    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]).toEqual({
      eventId: "evt-1",
      conversationKey: "conv-1",
      content: "/help explain this",
      events: [{ role: "user", content: "/help explain this" }],
      channelName: "test",
      source: {
        commandToken: "/new",
        raw: true,
      },
      channel: expect.any(Object),
      commandToken: "/help",
    });
  });

  it("falls back to source commandToken when inline content is not a command", async () => {
    const handledEvents: ChannelInboundEvent[] = [];

    const routeIncomingEvent = createIncomingEventRouter({
      channelRegistry: createChannelRegistry({
        webhookChannels: [createAdapter({
          parse: () => ({
            kind: "message",
            message: {
              eventId: "evt-2",
              conversationKey: "conv-2",
              channelName: "test",
              content: "hello there",
              source: {
                commandToken: "/new",
              },
            },
          }),
        })],
      }),
    });

    const response = await routeIncomingEvent(createEvent({}, {
      "x-test-channel": "yes",
    }), createHandlers({
      handleChannelRequest: async (event) => {
        handledEvents.push(event);
      },
    }));

    await response.afterResponse;

    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]?.commandToken).toBe("/new");
  });

  it("lowercases headers and decodes base64 bodies before adapter matching and parsing", async () => {
    const seenRequests: ChannelRequest[] = [];

    const routeIncomingEvent = createIncomingEventRouter({
      channelRegistry: createChannelRegistry({
        webhookChannels: [createAdapter({
          canHandle: (request) => {
            seenRequests.push(request);
            return request.headers["x-test-channel"] === "YES";
          },
          parse: (request) => {
            seenRequests.push(request);
            return {
              kind: "response",
              response: {
                statusCode: 200,
                body: request.body,
              },
            };
          },
        })],
      }),
    });

    const rawBody = JSON.stringify({ hello: "world" });
    const response = await routeIncomingEvent(createEvent(undefined, {
      "X-Test-Channel": "YES",
    }, {
      rawBody: Buffer.from(rawBody, "utf-8").toString("base64"),
      isBase64Encoded: true,
    }), createHandlers());

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(rawBody);
    const normalizedRequest = seenRequests.at(-1);
    if (normalizedRequest == null) {
      throw new Error("Expected adapter to receive the normalized request");
    }
    expect(normalizedRequest.headers["x-test-channel"]).toBe("YES");
    expect(normalizedRequest.body).toBe(rawBody);
  });

  it("returns 500 when adapter parsing throws", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      channelRegistry: createChannelRegistry({
        webhookChannels: [createAdapter({
          parse: () => {
            throw new Error("boom");
          },
        })],
      }),
    });

    const response = await routeIncomingEvent(createEvent({}, {
      "x-test-channel": "yes",
    }), createHandlers());

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe("Internal server error");
  });

  it("returns 500 when adapter actions throw", async () => {
    const routeIncomingEvent = createIncomingEventRouter({
      channelRegistry: createChannelRegistry({
        webhookChannels: [createAdapter({
          parse: () => ({
            kind: "message",
            message: {
              eventId: "evt-3",
              conversationKey: "conv-3",
              channelName: "test",
              content: "hello",
              source: {},
            },
          }),
          actions: () => {
            throw new Error("cannot create actions");
          },
        })],
      }),
    });

    const response = await routeIncomingEvent(createEvent({}, {
      "x-test-channel": "yes",
    }), createHandlers());

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe("Internal server error");
  });

  it("continues handling the channel request when typing and reaction fail", async () => {
    const handledEvents: ChannelInboundEvent[] = [];

    const routeIncomingEvent = createIncomingEventRouter({
      channelRegistry: createChannelRegistry({
        webhookChannels: [createAdapter({
          parse: () => ({
            kind: "message",
            message: {
              eventId: "evt-4",
              conversationKey: "conv-4",
              channelName: "test",
              content: "hello",
              source: {},
            },
          }),
          actions: () => ({
            sendText: async () => {},
            sendTyping: async () => {
              throw new Error("typing failed");
            },
            reactToMessage: async () => {
              throw new Error("reaction failed");
            },
          }),
        })],
      }),
    });

    const response = await routeIncomingEvent(createEvent({}, {
      "x-test-channel": "yes",
    }), createHandlers({
      handleChannelRequest: async (event) => {
        handledEvents.push(event);
      },
    }));

    await response.afterResponse;

    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]?.eventId).toBe("evt-4");
  });
});

function createChannelRegistry(overrides: Partial<ChannelRegistry> = {}): ChannelRegistry {
  return {
    telegramChannel: null,
    githubChannel: null,
    slackChannel: null,
    discordChannel: null,
    webhookChannels: [],
    ...overrides,
  };
}

function createAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    name: overrides.name ?? "test",
    canHandle: overrides.canHandle ?? ((request) => request.headers["x-test-channel"] === "yes"),
    authenticate: overrides.authenticate ?? (async () => true),
    parse: overrides.parse ?? (() => ({
      kind: "response",
      response: {
        statusCode: 200,
        body: "ok",
      },
    })),
    actions: overrides.actions ?? (() => ({
      sendText: async () => {},
      sendTyping: async () => {},
      reactToMessage: async () => {},
    })),
  };
}

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
    handleChannelRequest: overrides.handleChannelRequest ?? (async () => {}),
  };
}

function createEvent(
  body: unknown,
  headers: Record<string, string> = {},
  options: Partial<{
    method: string;
    rawBody: string;
    isBase64Encoded: boolean;
  }> = {},
): LambdaFunctionURLEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "example.lambda-url.aws",
      domainPrefix: "example",
      http: {
        method: options.method ?? "POST",
        path: "/",
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
