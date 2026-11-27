import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  OBSERVABILITY_TICKET_PREFIX,
  sealObservabilityTicket,
} from "../../../../packages/convex/model/observabilityTicket.ts";
import {
  attachMetadataToLatestUserIngress,
  createIncomingEventRouter,
  listRunnableAgents,
  type IntegrationRoutingOptions,
  type SandboxJobCompletionInboundEvent,
} from "../../../../apps/core/src/harness/integrations.ts";
import type { AuthContext } from "../../../../apps/core/src/shared/auth.ts";
import { getStorage } from "../../../../apps/core/src/shared/storage.ts";
import { coreRequest } from "../../../../apps/core/tests/helpers/http.ts";

type Handlers = Parameters<ReturnType<typeof createIncomingEventRouter>>[1];

const ACCOUNT = {
  accountId: "acct_test",
  username: "test-account",
  description: "Test account",
  secretHash: "hash",
  status: "active" as const,
  config: { sandboxes: [] },
  createdAt: "2026-04-24T00:00:00.000Z",
  updatedAt: "2026-04-24T00:00:00.000Z",
};

const AGENT = {
  accountId: "acct_test",
  agentId: "agent_test",
  name: "Test agent",
  status: "active" as const,
  config: { publicAccess: true },
  createdAt: "2026-04-24T00:00:00.000Z",
  updatedAt: "2026-04-24T00:00:00.000Z",
};

const USER_EVENT = { role: "user", content: [{ type: "text", text: "hello" }] };
const SECRET = "ticket-secret";
const ORIGINAL_SECRET = process.env.STAGE_TICKET_SECRET;

interface Answer {
  status: number;
  body: string;
}

const handlers: Handlers = {
  handleDirectRequest: async (): Promise<Response> => new Response("ok"),
  handleChannelRequest: async (): Promise<void> => {},
  handleSandboxJobCompletionRequest: async (
    event: SandboxJobCompletionInboundEvent,
  ): Promise<Response> => Response.json(event),
};

beforeEach((): void => {
  process.env.PUBLIC_BASE_URL = "https://gateway.broods.app";
  process.env.STAGE_TICKET_SECRET = SECRET;
});

afterEach((): void => {
  if (ORIGINAL_SECRET === undefined) delete process.env.STAGE_TICKET_SECRET;
  else process.env.STAGE_TICKET_SECRET = ORIGINAL_SECRET;
  spyOn(getStorage().accounts, "getById").mockRestore();
});

async function route(
  rawPath: string,
  headers: Record<string, string>,
  body: string,
  options: IntegrationRoutingOptions = {},
): Promise<Answer> {
  const router = createIncomingEventRouter({
    authResolver: async (): Promise<AuthContext> => ({
      kind: "account",
      account: ACCOUNT,
    }),
    agentLoader: async (): Promise<typeof AGENT> => AGENT,
    ...options,
  });
  const response = await router(
    coreRequest("POST", rawPath, headers, body),
    handlers,
  );

  return { status: response.status, body: await response.text() };
}

async function direct(body: Record<string, unknown>): Promise<Answer> {
  return await route(
    "/v1/runs",
    { authorization: "Bearer secret" },
    JSON.stringify({
      agentId: "agent_test",
      eventId: "event-1",
      conversationKey: "chat-1",
      ...body,
    }),
  );
}

async function directEvent(event: unknown): Promise<Answer> {
  return await direct({ events: [event] });
}

function message(answer: Answer): string {
  return (JSON.parse(answer.body) as { error: { message: string } }).error
    .message;
}

describe("parseDirectPayload", (): void => {
  test("rejects a body that is not JSON", async (): Promise<void> => {
    const answer = await route(
      "/v1/runs",
      { authorization: "Bearer secret" },
      "{not json",
    );

    expect(answer.status).toBe(400);
    expect(message(answer)).toStartWith("Invalid request JSON:");
  });

  test("rejects a body that is not an object", async (): Promise<void> => {
    const answer = await route(
      "/v1/runs",
      { authorization: "Bearer secret" },
      "[1]",
    );

    expect(answer.status).toBe(400);
    expect(message(answer)).toBe("Request body must be a JSON object");
  });
});

describe("assertOneDirectPayloadShape", (): void => {
  test("refuses continue combined with events", async (): Promise<void> => {
    const answer = await direct({ continue: true, events: [USER_EVENT] });

    expect(message(answer)).toBe(
      "Request body cannot combine continue with events or answers",
    );
  });

  test("refuses continue combined with a system override", async (): Promise<void> => {
    const answer = await direct({
      continue: true,
      system: { role: "system", content: "be brief" },
    });

    expect(message(answer)).toBe(
      "Request body cannot combine continue with system or model overrides",
    );
  });

  test("refuses a turn with no events and no answers", async (): Promise<void> => {
    const answer = await direct({});

    expect(message(answer)).toBe(
      "Request body must include a non-empty events or answers array",
    );
  });

  test("refuses events combined with answers", async (): Promise<void> => {
    const answer = await direct({
      events: [USER_EVENT],
      answers: [{ statusId: "st1", answers: { q1: ["yes"] } }],
    });

    expect(message(answer)).toBe(
      "Request body cannot combine events with answers; send the answers first",
    );
  });
});

describe("parseDirectIngressEvent", (): void => {
  test.each<[string, unknown, string]>([
    [
      "a non-boolean persist",
      { role: "system", content: "x", persist: "yes" },
      "Event field 'persist' must be a boolean when provided",
    ],
    [
      "persist on a user event",
      { ...USER_EVENT, persist: true },
      "Only system-role events may set persist",
    ],
    ["a malformed user event", { role: "user" }, "Invalid direct event:"],
    ["a malformed tool event", { role: "tool" }, "Invalid direct event:"],
    [
      "a tool event with a non-approval part",
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
      "Direct API tool events may include only tool-approval-response parts",
    ],
    [
      "an assistant event",
      { role: "assistant", content: "hi" },
      "Direct API accepts only user, tool approval, and ephemeral system events",
    ],
    [
      "a persisted system event",
      { role: "system", content: "x", persist: true },
      "Direct API system events cannot be persisted",
    ],
    ["a malformed system event", { role: "system" }, "Invalid direct event:"],
  ])("refuses %s", async (_label, event, expected): Promise<void> => {
    const answer = await directEvent(event);

    expect(answer.status).toBe(400);
    expect(message(answer)).toContain(expected);
  });
});

describe("direct payload fields", (): void => {
  test.each<[string, Record<string, unknown>, string]>([
    [
      "answers that are not an array",
      { answers: "yes" },
      "Request body field 'answers' must be an array",
    ],
    [
      "an answer that is not an object",
      { answers: ["yes"] },
      "Each answer must be an object with statusId and answers",
    ],
    [
      "answer labels that are not strings",
      { answers: [{ statusId: "st1", answers: { q1: [1] } }] },
      "Answer for question 'q1' must be an array of strings",
    ],
    [
      "an empty system override",
      { events: [USER_EVENT], system: [] },
      "system must include at least one SystemModelMessage",
    ],
    [
      "a model override that is not an object",
      { events: [USER_EVENT], model: "fast" },
      "model must be an object",
    ],
    [
      "an unknown mode",
      { events: [USER_EVENT], mode: "sideways" },
      "mode must be reject, followup, collect, or steer",
    ],
  ])("refuses %s", async (_label, body, expected): Promise<void> => {
    const answer = await direct(body);

    expect(answer.status).toBe(400);
    expect(message(answer)).toBe(expected);
  });
});

describe("parseSandboxJobCompletionPayload", (): void => {
  const path = "/v1/sandbox-jobs/result%201/complete";

  test("refuses a missing job token", async (): Promise<void> => {
    const answer = await route(path, {}, "{}");

    expect(message(answer)).toBe(
      "Background job completion requires the x-job-token header",
    );
  });

  test("refuses a body that is not JSON", async (): Promise<void> => {
    const answer = await route(path, { "x-job-token": "t" }, "nope");

    expect(message(answer)).toStartWith("Invalid request JSON:");
  });

  test("refuses a body that is not an object", async (): Promise<void> => {
    const answer = await route(path, { "x-job-token": "t" }, "3");

    expect(message(answer)).toBe(
      "Background job completion body must be an object",
    );
  });

  test("refuses an unknown status", async (): Promise<void> => {
    const answer = await route(
      path,
      { "x-job-token": "t" },
      JSON.stringify({ status: "running" }),
    );

    expect(message(answer)).toBe(
      "Background job completion status must be completed or failed",
    );
  });
});

describe("observabilityTicketScope", (): void => {
  async function ticket(): Promise<string> {
    return await sealObservabilityTicket(
      {
        accountId: "acct_test",
        endpointId: "env-endpoint",
        projectSlug: "demo",
        stageSlug: "development",
        expiresAt: Date.now() + 60_000,
      },
      SECRET,
    );
  }

  async function scope(
    token: string,
    status: "active" | "suspended",
  ): Promise<Answer> {
    spyOn(getStorage().accounts, "getById").mockResolvedValue({
      ...ACCOUNT,
      status: status,
    });

    return await route(
      "/v1/internal/observability-scope",
      { authorization: `Bearer ${token}` },
      "{}",
      { authResolver: async (): Promise<AuthContext | null> => null },
    );
  }

  test("answers a ticket of an active account with its scope", async (): Promise<void> => {
    const answer = await scope(await ticket(), "active");

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({
      accountId: "acct_test",
      projectSlug: "demo",
      stageSlug: "development",
      endpointIds: ["env-endpoint"],
    });
  });

  test("refuses a ticket of an inactive account", async (): Promise<void> => {
    const answer = await scope(await ticket(), "suspended");

    expect(answer.status).toBe(401);
  });

  test("refuses a ticket that does not verify", async (): Promise<void> => {
    const answer = await scope(
      `${OBSERVABILITY_TICKET_PREFIX}forged`,
      "active",
    );

    expect(answer.status).toBe(401);
  });
});

describe("listRunnableAgents", (): void => {
  test("lists nothing for a run token", async (): Promise<void> => {
    const agents = await listRunnableAgents({
      kind: "agent",
      account: ACCOUNT,
      agentId: "agent_test",
    });

    expect(agents).toEqual([]);
  });

  test("lists nothing for a user token that names its conversations", async (): Promise<void> => {
    const agents = await listRunnableAgents({
      kind: "deployment",
      account: ACCOUNT,
      endpointId: "env-endpoint",
      projectSlug: "demo",
      stageSlug: "development",
      user: {
        userId: "alice",
        expiresAt: 1_900_000_000_000,
        conversations: ["chat_1"],
      },
    });

    expect(agents).toEqual([]);
  });
});

describe("attachMetadataToLatestUserIngress", (): void => {
  test("leaves events with no user turn unchanged", (): void => {
    const events = [{ role: "system" as const, content: "rules" }];

    expect(attachMetadataToLatestUserIngress(events, { a: 1 })).toBe(events);
  });

  test("skips a trailing non-user event to tag the latest user turn", (): void => {
    const events = [
      { role: "user" as const, content: "one" },
      { role: "system" as const, content: "rules" },
    ];

    expect(attachMetadataToLatestUserIngress(events, { a: 1 })).toEqual([
      { role: "user", content: "one", metadata: { a: 1 } },
      { role: "system", content: "rules" },
    ]);
  });
});
