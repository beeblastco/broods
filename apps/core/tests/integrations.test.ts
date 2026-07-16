import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AuthContext } from "../src/shared/auth.ts";
import {
  createIncomingEventRouter,
  type AsyncDirectInboundEvent,
  type AsyncToolCompletionInboundEvent,
  type ChannelInboundEvent,
  type DirectInboundEvent,
  type StatusInboundEvent,
} from "../src/harness/integrations.ts";
import { coreRequest } from "./helpers/http.ts";

const TEST_ACCOUNT = {
  accountId: "acct_test",
  username: "test-account",
  description: "Test account",
  secretHash: "hash",
  status: "active" as const,
  config: {
    model: {
      provider: "google" as const,
      modelId: "gemini-test",
    },
    provider: {
      google: {
        apiKey: "google-key",
      },
    },
    sandbox: "sb_1",
    workspaces: [{ name: "notes", workspaceId: "ws_a" }],
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

const TEST_AGENT = {
  accountId: "acct_test",
  agentId: "agent_test",
  name: "Test agent",
  status: "active" as const,
  // Opted into the public endpoint so the deployment (runtime-key) path is allowed.
  config: { ...TEST_ACCOUNT.config, publicAccess: true },
  createdAt: "2026-04-24T00:00:00.000Z",
  updatedAt: "2026-04-24T00:00:00.000Z",
};

// A second agent that has NOT opted into the public endpoint, used to assert the
// secure-by-default gate on the deployment (runtime-key) path.
const TEST_AGENT_PRIVATE = {
  ...TEST_AGENT,
  agentId: "agent_private",
  name: "Private agent",
  config: TEST_ACCOUNT.config,
};

const ORIGINAL_PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

beforeEach(() => {
  process.env.PUBLIC_BASE_URL = "https://gateway.broods.app";
});

afterEach(() => {
  if (ORIGINAL_PUBLIC_BASE_URL === undefined)
    delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = ORIGINAL_PUBLIC_BASE_URL;
});

describe("direct API ingress", () => {
  it("returns 401 when the account bearer token is missing", async () => {
    const response = await routeIncomingEvent(
      createEvent({
        eventId: "one",
        conversationKey: "alpha",
        events: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      }),
      createHandlers(),
    );

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("returns 200 for GET probes without requiring direct API configuration", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        undefined,
        {},
        {
          method: "GET",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(200);
    expect(responseJson(response)).toEqual({ status: "ok", method: "POST" });
  });

  it("returns 405 for unsupported request methods", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        undefined,
        {},
        {
          method: "PUT",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(405);
    expect(responseJson(response)).toEqual({
      error: "Method not allowed",
      method: "PUT",
      allowedMethods: ["GET", "POST"],
    });
  });

  it("accepts an env-scoped runtime key on the public endpoint path and selects the agent by id", async () => {
    const handledEvents: DirectInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        {
          agentId: "agent_test",
          eventId: "one",
          conversationKey: "chat_1",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer fp_agent_test",
        },
        {
          rawPath: "/v1/demo/agents/development/env-endpoint",
          addDefaultAgentId: false,
        },
      ),
      createHandlers({
        handleDirectRequest: async (event) => {
          handledEvents.push(event);

          return {
            statusCode: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body: "ok",
          };
        },
      }),
      {
        authResolver: async (headers) =>
          headers.authorization === "Bearer fp_agent_test"
            ? {
                kind: "deployment",
                account: TEST_ACCOUNT,
                endpointId: "env-endpoint",
                projectSlug: "demo",
                environmentSlug: "development",
              }
            : null,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]?.agentId).toBe("agent_test");
    expect(handledEvents[0]?.publicConversationKey).toBe("chat_1");
    expect(handledEvents[0]?.events).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ]);
  });

  it("preserves websocket connection ids for the NATS worker path", async () => {
    const handledEvents: DirectInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        {
          agentId: "agent_test",
          eventId: "one",
          conversationKey: "chat_1",
          connectionId: "conn_123",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer fp_agent_test",
        },
        {
          rawPath: "/v1/demo/agents/development/env-endpoint",
          addDefaultAgentId: false,
        },
      ),
      createHandlers({
        handleDirectRequest: async (event) => {
          handledEvents.push(event);

          return {
            statusCode: 202,
            headers: { "Content-Type": "application/json" },
            body: "{}",
          };
        },
      }),
      {
        authResolver: async (headers) =>
          headers.authorization === "Bearer fp_agent_test"
            ? {
                kind: "deployment",
                account: TEST_ACCOUNT,
                endpointId: "env-endpoint",
                projectSlug: "demo",
                environmentSlug: "development",
              }
            : null,
      },
    );

    expect(response.statusCode).toBe(202);
    expect(handledEvents[0]?.connectionId).toBe("conn_123");
  });

  it("rejects an env-scoped runtime key when the scoped path endpoint does not match", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          agentId: "agent_test",
          eventId: "one",
          conversationKey: "chat_1",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer fp_agent_test",
        },
        {
          rawPath: "/v1/demo/agents/development/some-other-endpoint",
          addDefaultAgentId: false,
        },
      ),
      createHandlers(),
      {
        authResolver: async (headers) =>
          headers.authorization === "Bearer fp_agent_test"
            ? {
                kind: "deployment",
                account: TEST_ACCOUNT,
                endpointId: "env-endpoint",
                projectSlug: "demo",
                environmentSlug: "development",
              }
            : null,
      },
    );

    expect(response.statusCode).toBe(401);
  });

  it("refuses the public runtime key for an agent that has not opted into public access", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          agentId: "agent_private",
          eventId: "one",
          conversationKey: "chat_1",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer fp_agent_test",
        },
        {
          rawPath: "/v1/demo/agents/development/env-endpoint",
          addDefaultAgentId: false,
        },
      ),
      createHandlers(),
      {
        authResolver: async (headers) =>
          headers.authorization === "Bearer fp_agent_test"
            ? {
                kind: "deployment",
                account: TEST_ACCOUNT,
                endpointId: "env-endpoint",
                projectSlug: "demo",
                environmentSlug: "development",
              }
            : null,
      },
    );

    expect(response.statusCode).toBe(403);
    expect(responseJson(response).code).toBe("public_access_disabled");
  });

  it("returns 404 for direct sync and async POST when direct API is disabled", async () => {
    const body = {
      eventId: "one",
      conversationKey: "alpha",
      events: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    };

    const syncResponse = await routeIncomingEvent(
      createEvent(body, {
        authorization: "Bearer secret",
      }),
      createHandlers(),
      { directApiEnabled: false },
    );
    const asyncResponse = await routeIncomingEvent(
      createEvent(
        body,
        {
          authorization: "Bearer secret",
        },
        { rawPath: "/async" },
      ),
      createHandlers(),
      { directApiEnabled: false },
    );

    expect(syncResponse.statusCode).toBe(404);
    expect(responseJson(syncResponse)).toEqual({
      error: "Direct API is disabled",
    });
    expect(asyncResponse.statusCode).toBe(404);
    expect(responseJson(asyncResponse)).toEqual({
      error: "Direct API is disabled",
    });
  });

  it("returns 401 when the bearer token is malformed", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "one",
          conversationKey: "alpha",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer secret extra",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when the bearer token does not match", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "one",
          conversationKey: "alpha",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer secrets",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("returns 400 for invalid direct API JSON", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        undefined,
        {
          authorization: "Bearer secret",
        },
        {
          rawBody: "{",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response).error).toContain("Invalid request JSON:");
  });

  it("returns 400 when eventId or conversationKey is missing", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "one",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error: "Request body must include eventId and conversationKey",
    });
  });

  it("requires an agentId for direct API requests", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          agentId: undefined,
          eventId: "one",
          conversationKey: "alpha",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer secret",
        },
        {
          addDefaultAgentId: false,
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error: "Request body must include agentId",
    });
  });

  it("returns 404 when the requested agent does not exist", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          agentId: "missing-agent",
          eventId: "one",
          conversationKey: "alpha",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(404);
    expect(responseJson(response)).toEqual({ error: "Agent not found" });
  });

  it("rejects reserved direct event prefixes", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "gh:issue",
          conversationKey: "alpha",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error: "eventId uses a reserved internal prefix",
    });
  });

  it("rejects reserved direct conversation prefixes", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "one",
          conversationKey: "gh:owner/repo:issue:1",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error: "conversationKey uses a reserved channel or internal prefix",
    });
  });

  it("returns 400 when the events field is not an array", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "one",
          conversationKey: "alpha",
          events: "hello",
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error: "Request body field 'events' must be an array",
    });
  });

  it("returns 400 when the events array is empty", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "one",
          conversationKey: "alpha",
          events: [],
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error: "Request body must include a non-empty events array",
    });
  });

  it("returns 400 when a direct event is not an object", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "one",
          conversationKey: "alpha",
          events: ["hello"],
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error: "Each direct event must be an object",
    });
  });

  it("returns 400 when persist is set on a non-system event", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "one",
          conversationKey: "alpha",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
              persist: false,
            },
          ],
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error: "Only system-role events may set persist",
    });
  });

  it("rejects persisted system events", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
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
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error: "Direct API system events cannot be persisted",
    });
  });

  it("normalizes direct events before handing them to the application handler", async () => {
    const handledEvents: DirectInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        {
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
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers({
        handleDirectRequest: async (event) => {
          handledEvents.push(event);
          return {
            statusCode: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body: "ok",
          };
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(handledEvents).toHaveLength(1);
    const directEvent = handledEvents[0];
    if (directEvent == null) {
      throw new Error("Expected direct event to be handled");
    }
    expect(directEvent.eventId).toBe("acct:acct_test:agent:agent_test:api:one");
    expect(directEvent.accountId).toBe("acct_test");
    expect(directEvent.agentId).toBe("agent_test");
    expect(directEvent.agentConfig).toEqual({
      model: {
        provider: "google",
        modelId: "gemini-test",
      },
      provider: {
        google: {
          apiKey: "google-key",
        },
      },
      sandbox: "sb_1",
      workspaces: [{ name: "notes", workspaceId: "ws_a" }],
      publicAccess: true,
    });
    expect(directEvent.publicEventId).toBe("one");
    expect(directEvent.requestedMode).toBe("reject");
    expect(directEvent.idempotencyKey).toBe("one");
    expect(directEvent.conversationKey).toBe(
      "acct:acct_test:agent:agent_test:api:alpha",
    );
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

  it("parses explicit ingress mode and idempotency identity", async () => {
    const handledEvents: DirectInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "steer-1",
          conversationKey: "alpha",
          mode: "steer",
          idempotencyKey: "client-operation-1",
          events: [{ role: "user", content: "change direction" }],
        },
        { authorization: "Bearer secret" },
      ),
      createHandlers({
        handleDirectRequest: async (event) => {
          handledEvents.push(event);
          return { statusCode: 202, body: "{}" };
        },
      }),
    );

    expect(response.statusCode).toBe(202);
    expect(handledEvents[0]).toMatchObject({
      requestedMode: "steer",
      idempotencyKey: "client-operation-1",
      publicEventId: "steer-1",
      publicConversationKey: "alpha",
    });
  });

  it("passes top-level system as ephemeral AI SDK system messages", async () => {
    const handledEvents: DirectInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "system-override",
          conversationKey: "alpha",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
          system: {
            role: "system",
            content: "one-turn instruction",
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral" } },
            },
          },
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers({
        handleDirectRequest: async (event) => {
          handledEvents.push(event);
          return {
            statusCode: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body: "ok",
          };
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(handledEvents[0]?.ephemeralSystem).toEqual([
      {
        role: "system",
        content: "one-turn instruction",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ]);
  });

  it("rejects the params wrapper on direct API requests", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "params-wrapper",
          conversationKey: "alpha",
          events: [
            { role: "user", content: [{ type: "text", text: "hello" }] },
          ],
          params: { model: { temperature: 0 } },
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Request body params is not supported");
  });

  it("accepts direct tool approval response events", async () => {
    const handledEvents: DirectInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "approval-one",
          conversationKey: "alpha",
          events: [
            {
              role: "tool",
              content: [
                {
                  type: "tool-approval-response",
                  approvalId: "approval-1",
                  approved: true,
                  reason: "confirmed",
                },
              ],
            },
          ],
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers({
        handleDirectRequest: async (event) => {
          handledEvents.push(event);
          return {
            statusCode: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body: "ok",
          };
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(handledEvents[0]?.events).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "approval-1",
            approved: true,
            reason: "confirmed",
          },
        ],
      },
    ]);
  });

  it("rejects direct tool events that are not approval responses", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "tool-result",
          conversationKey: "alpha",
          events: [
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "tool-call-1",
                  toolName: "bash",
                  output: { type: "text", value: "done" },
                },
              ],
            },
          ],
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error:
        "Direct API tool events may include only tool-approval-response parts",
    });
  });

  it("rejects empty direct tool events", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "empty-tool",
          conversationKey: "alpha",
          events: [
            {
              role: "tool",
              content: [],
            },
          ],
        },
        {
          authorization: "Bearer secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error:
        "Direct API tool events may include only tool-approval-response parts",
    });
  });

  it("routes async direct API requests with a status URL", async () => {
    const handledEvents: AsyncDirectInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "one",
          conversationKey: "alpha",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer secret",
          host: "example.lambda-url.aws",
          "x-forwarded-proto": "https",
        },
        {
          rawPath: "/async",
        },
      ),
      createHandlers({
        handleAsyncRequest: async (event) => {
          handledEvents.push(event);
          return {
            statusCode: 202,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ statusUrl: event.statusUrl }),
          };
        },
      }),
    );

    expect(response.statusCode).toBe(202);
    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]?.eventId).toBe(
      "acct:acct_test:agent:agent_test:api:one",
    );
    expect(handledEvents[0]?.statusUrl).toBe(
      "https://gateway.broods.app/status/one?agentId=agent_test",
    );
  });

  it("routes async direct API requests with an env-scoped runtime key", async () => {
    const handledEvents: AsyncDirectInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        {
          agentId: "agent_test",
          eventId: "one",
          conversationKey: "alpha",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer fp_agent_test",
          host: "example.lambda-url.aws",
          "x-forwarded-proto": "https",
        },
        {
          rawPath: "/async",
          addDefaultAgentId: false,
        },
      ),
      createHandlers({
        handleAsyncRequest: async (event) => {
          handledEvents.push(event);
          return {
            statusCode: 202,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ statusUrl: event.statusUrl }),
          };
        },
      }),
      {
        authResolver: async (headers) =>
          headers.authorization === "Bearer fp_agent_test"
            ? {
                kind: "deployment",
                account: TEST_ACCOUNT,
                endpointId: "env-endpoint",
                projectSlug: "demo",
                environmentSlug: "development",
              }
            : null,
      },
    );

    expect(response.statusCode).toBe(202);
    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]?.eventId).toBe(
      "acct:acct_test:agent:agent_test:api:one",
    );
    expect(handledEvents[0]?.statusUrl).toBe(
      "https://gateway.broods.app/status/one?agentId=agent_test",
    );
  });

  it("routes scoped async direct API requests with an env-scoped runtime key", async () => {
    const handledEvents: AsyncDirectInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        {
          agentId: "agent_test",
          eventId: "one",
          conversationKey: "alpha",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer fp_agent_test",
          host: "gateway.broods.app",
          "x-forwarded-proto": "https",
        },
        {
          rawPath: "/v1/demo/agents/development/env-endpoint/async",
          addDefaultAgentId: false,
        },
      ),
      createHandlers({
        handleAsyncRequest: async (event) => {
          handledEvents.push(event);
          return {
            statusCode: 202,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ statusUrl: event.statusUrl }),
          };
        },
      }),
      {
        authResolver: async (headers) =>
          headers.authorization === "Bearer fp_agent_test"
            ? {
                kind: "deployment",
                account: TEST_ACCOUNT,
                endpointId: "env-endpoint",
                projectSlug: "demo",
                environmentSlug: "development",
              }
            : null,
      },
    );

    expect(response.statusCode).toBe(202);
    expect(handledEvents).toHaveLength(1);
    expect(handledEvents[0]?.endpointId).toBe("env-endpoint");
    expect(handledEvents[0]?.projectSlug).toBe("demo");
    expect(handledEvents[0]?.environmentSlug).toBe("development");
    expect(handledEvents[0]?.statusUrl).toBe(
      "https://gateway.broods.app/status/one?agentId=agent_test",
    );
  });

  it("rejects per-request webhook callback config for direct API requests", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          eventId: "one",
          conversationKey: "alpha",
          webhookUrl: "https://callbacks.example/hook",
          events: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
        },
        {
          authorization: "Bearer secret",
          "x-webhook-secret": "webhook-secret",
        },
      ),
      createHandlers(),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error:
        "Per-request webhook callbacks are no longer supported; configure config.hooks.webhook on the agent",
    });
  });

  it("routes status requests through direct API auth", async () => {
    const handledEvents: StatusInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        undefined,
        {
          authorization: "Bearer secret",
        },
        {
          method: "GET",
          rawPath: "/status/one",
          rawQueryString: "agentId=agent_test",
        },
      ),
      createHandlers({
        handleStatusRequest: async (event) => {
          handledEvents.push(event);
          return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "processing" }),
          };
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(handledEvents).toEqual([
      {
        accountId: "acct_test",
        agentId: "agent_test",
        eventId: "acct:acct_test:agent:agent_test:api:one",
        publicEventId: "one",
      },
    ]);
  });

  it("routes status requests through env-scoped runtime key auth", async () => {
    const handledEvents: StatusInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        undefined,
        {
          authorization: "Bearer fp_agent_test",
        },
        {
          method: "GET",
          rawPath: "/status/one",
          rawQueryString: "agentId=agent_test",
        },
      ),
      createHandlers({
        handleStatusRequest: async (event) => {
          handledEvents.push(event);
          return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "processing" }),
          };
        },
      }),
      {
        authResolver: async (headers) =>
          headers.authorization === "Bearer fp_agent_test"
            ? {
                kind: "deployment",
                account: TEST_ACCOUNT,
                endpointId: "env-endpoint",
                projectSlug: "demo",
                environmentSlug: "development",
              }
            : null,
      },
    );

    expect(response.statusCode).toBe(200);
    expect(handledEvents).toEqual([
      {
        accountId: "acct_test",
        agentId: "agent_test",
        eventId: "acct:acct_test:agent:agent_test:api:one",
        publicEventId: "one",
      },
    ]);
  });

  it("routes async tool completion requests through account auth", async () => {
    const handledEvents: AsyncToolCompletionInboundEvent[] = [];
    const response = await routeIncomingEvent(
      createEvent(
        {
          status: "completed",
          response: { answer: "done" },
        },
        {
          authorization: "Bearer secret",
        },
        {
          rawPath: "/async-tools/async_tool_1/complete",
        },
      ),
      createHandlers({
        handleAsyncToolCompletionRequest: async (event) => {
          handledEvents.push(event);
          return {
            statusCode: 202,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "accepted" }),
          };
        },
      }),
    );

    expect(response.statusCode).toBe(202);
    expect(handledEvents).toEqual([
      {
        accountId: "acct_test",
        resultId: "async_tool_1",
        status: "completed",
        response: { answer: "done" },
      },
    ]);
  });

  it("validates async tool failed completion errors", async () => {
    const response = await routeIncomingEvent(
      createEvent(
        {
          status: "failed",
        },
        {
          authorization: "Bearer secret",
        },
        {
          rawPath: "/async-tools/async_tool_1/complete",
        },
      ),
      createHandlers({
        handleAsyncToolCompletionRequest: async () => ({
          statusCode: 202,
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({
      error:
        "Async tool completion error must be a string when status is failed",
    });
  });
});

function createHandlers(
  overrides: Partial<{
    handleDirectRequest(event: DirectInboundEvent): Promise<ResponseShape>;
    handleAsyncRequest(event: AsyncDirectInboundEvent): Promise<ResponseShape>;
    handleStatusRequest(event: StatusInboundEvent): Promise<ResponseShape>;
    handleAsyncToolCompletionRequest(
      event: AsyncToolCompletionInboundEvent,
    ): Promise<ResponseShape>;
    handleChannelRequest(event: ChannelInboundEvent): Promise<void>;
  }> = {},
) {
  return {
    handleDirectRequest: async (event: DirectInboundEvent) =>
      responseFromShape(
        await (overrides.handleDirectRequest ?? defaultDirectHandler)(event),
      ),
    handleAsyncRequest: overrides.handleAsyncRequest
      ? async (event: AsyncDirectInboundEvent) =>
          responseFromShape(await overrides.handleAsyncRequest!(event))
      : undefined,
    handleStatusRequest: overrides.handleStatusRequest
      ? async (event: StatusInboundEvent) =>
          responseFromShape(await overrides.handleStatusRequest!(event))
      : undefined,
    handleAsyncToolCompletionRequest: overrides.handleAsyncToolCompletionRequest
      ? async (event: AsyncToolCompletionInboundEvent) =>
          responseFromShape(
            await overrides.handleAsyncToolCompletionRequest!(event),
          )
      : undefined,
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

async function routeIncomingEvent(
  event: ReturnType<typeof coreRequest>,
  handlers: ReturnType<typeof createHandlers>,
  options: {
    directApiEnabled?: boolean;
    authResolver?: (
      headers: Record<string, string>,
    ) => Promise<AuthContext | null>;
  } = {},
): Promise<ResponseShape> {
  const router = createIncomingEventRouter({
    authResolver:
      options.authResolver ??
      (async (headers) =>
        headers.authorization === "Bearer secret"
          ? { kind: "account", account: TEST_ACCOUNT }
          : null),
    agentLoader: async (_accountId, agentId) =>
      agentId === TEST_AGENT.agentId
        ? TEST_AGENT
        : agentId === TEST_AGENT_PRIVATE.agentId
          ? TEST_AGENT_PRIVATE
          : null,
    directApiEnabled: options.directApiEnabled,
  });

  const response = await router(event, handlers);
  return responseToShape(response);
}

function createEvent(
  body: unknown,
  headers: Record<string, string> = {},
  options: Partial<{
    method: string;
    rawPath: string;
    rawQueryString: string;
    rawBody: string;
    isBase64Encoded: boolean;
    addDefaultAgentId: boolean;
  }> = {},
): ReturnType<typeof coreRequest> {
  const rawPath = options.rawPath ?? "/";
  const normalizedBody =
    options.addDefaultAgentId !== false &&
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    !("agentId" in body)
      ? { agentId: "agent_test", ...(body as Record<string, unknown>) }
      : body;

  return coreRequest(
    options.method ?? "POST",
    options.rawQueryString ? `${rawPath}?${options.rawQueryString}` : rawPath,
    headers,
    options.rawBody ?? JSON.stringify(normalizedBody),
  );
}

interface ResponseShape {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

function responseJson(response: ResponseShape): Record<string, unknown> {
  return JSON.parse(response.body ?? "{}") as Record<string, unknown>;
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
