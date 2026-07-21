/**
 * Status route compatibility tests: the durable ingress record merges with the
 * async agent result so approval-required and still-running async runs keep the
 * pre-ingress top-level polling contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  hashAccountSecret,
  type AccountRecord,
} from "../src/shared/domain/accounts.ts";
import {
  resetStorageForTests,
  setStorageForTests,
  type Storage,
} from "../src/shared/storage.ts";
import { runtime } from "../src/shared/convex/runtime.ts";
import { coreRequest, responseJson } from "./helpers/http.ts";

const { handler } = await import("../src/harness/handler.ts");

const ACCOUNT: AccountRecord = {
  accountId: "acct_1",
  username: "tester",
  secretHash: hashAccountSecret("fp_acct_known-secret"),
  status: "active",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};
const SCOPED_EVENT_ID = "acct:acct_1:agent:agent_1:api:one";
const SCOPED_CONVERSATION_KEY = "acct:acct_1:agent:agent_1:api:conversation-1";
const APPROVALS = [
  {
    approvalId: "approval-1",
    toolCallId: "call-1",
    toolName: "bash",
    input: { shell: "true" },
  },
];

const originalQuery = runtime.query;
let ingressRow: Record<string, unknown> | null;
let asyncRow: Record<string, unknown> | null;

beforeEach(() => {
  setStorageForTests({
    accounts: {
      getById: async (accountId: string) =>
        accountId === ACCOUNT.accountId ? ACCOUNT : null,
      getBySecretHash: async (secretHash: string) =>
        secretHash === ACCOUNT.secretHash ? ACCOUNT : null,
    },
    agentDeployments: {
      getByApiKeyHash: async () => null,
    },
  } as unknown as Storage);
  runtime.query = (async (name: string) => {
    if (name === "getIngressStatus") return ingressRow;
    if (name === "getAsyncAgentResult") return asyncRow;
    return null;
  }) as never;
});

afterEach(() => {
  resetStorageForTests();
  runtime.query = originalQuery;
});

function statusRequest() {
  return handler(
    coreRequest("GET", "/status/one?agentId=agent_1", {
      authorization: "Bearer fp_acct_known-secret",
    }),
  );
}

function ingress(overrides: Record<string, unknown> = {}) {
  return {
    eventId: SCOPED_EVENT_ID,
    conversationKey: SCOPED_CONVERSATION_KEY,
    requestedMode: "reject",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 3,
    ...overrides,
  };
}

describe("status route ingress/async merge", () => {
  it("surfaces awaiting_approval and approvals top-level over a settled envelope", async () => {
    ingressRow = ingress({
      result: { status: "awaiting_approval", approvals: APPROVALS },
    });
    asyncRow = {
      eventId: SCOPED_EVENT_ID,
      conversationKey: SCOPED_CONVERSATION_KEY,
      status: "awaiting_approval",
      approvals: APPROVALS,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:01.000Z",
      expiresAt: 1780000000,
    };

    const response = await statusRequest();
    expect(response.status).toBe(200);
    const payload = await responseJson(response);
    expect(payload.status).toBe("awaiting_approval");
    expect(payload.approvals).toEqual(APPROVALS);
    expect(payload.conversationKey).toBe("conversation-1");
  });

  it("keeps polling alive while detached async tools are still running", async () => {
    ingressRow = ingress({
      result: { status: "waiting_for_async_tools" },
    });
    asyncRow = {
      eventId: SCOPED_EVENT_ID,
      conversationKey: SCOPED_CONVERSATION_KEY,
      status: "processing",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:01.000Z",
      expiresAt: 1780000000,
    };

    const payload = await responseJson(await statusRequest());
    expect(payload.status).toBe("processing");
  });

  it("returns the completed response once the async record settles", async () => {
    ingressRow = ingress();
    asyncRow = {
      eventId: SCOPED_EVENT_ID,
      conversationKey: SCOPED_CONVERSATION_KEY,
      status: "completed",
      response: { answer: "done" },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:01.000Z",
      expiresAt: 1780000000,
    };

    const payload = await responseJson(await statusRequest());
    expect(payload.status).toBe("completed");
    expect(payload.response).toEqual({ answer: "done" });
  });

  it("serves pure ingress statuses unchanged when no async record exists", async () => {
    ingressRow = ingress({ status: "queued" });
    asyncRow = null;

    const payload = await responseJson(await statusRequest());
    expect(payload.status).toBe("queued");
    expect(payload.requestedMode).toBe("reject");
  });

  it("returns 404 when neither record exists", async () => {
    ingressRow = null;
    asyncRow = null;

    const response = await statusRequest();
    expect(response.status).toBe(404);
  });
});
