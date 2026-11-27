import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as ingress from "../../../../apps/core/src/harness/ingress.ts";
import * as workerQueue from "../../../../apps/core/src/harness/worker-queue.ts";
import type { AsyncToolResultRecord } from "../../../../apps/core/src/harness/async-tool-result.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";
import {
  getStorage,
  resetStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";
import { coreRequest } from "../../../../apps/core/tests/helpers/http.ts";

const { handler } =
  await import("../../../../apps/core/src/harness/handler.ts");

const PARENT_EVENT = "acct:acct_1:agent:agent_1:api:event_0";
const CONVERSATION = "acct:acct_1:agent:agent_1:api:chat";

type Settled = AsyncToolResultRecord | null;

const rows = new Map<string, AsyncToolResultRecord>();
const settleWith = new Map<string, Settled>();
const workers: string[] = [];

function question(
  resultId: string,
  overrides: Partial<AsyncToolResultRecord> = {},
): AsyncToolResultRecord {
  return {
    resultId: resultId,
    parentEventId: PARENT_EVENT,
    conversationKey: CONVERSATION,
    toolName: "ask_questions",
    toolCallId: `call_${resultId}`,
    input: {
      questions: [
        {
          id: "q1",
          header: "Region",
          question: "Which?",
          options: [{ label: "eu" }],
        },
      ],
      blocking: true,
      answerBy: new Date(Date.now() + 3_600_000).toISOString(),
    },
    status: "processing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

function answer(...statusIds: string[]): Promise<Response> {
  return handler(
    coreRequest(
      "POST",
      "/v1/runs",
      { authorization: "Bearer service-secret", "x-account-id": "acct_1" },
      {
        agentId: "agent_1",
        eventId: "answer-event",
        conversationKey: "chat",
        answers: statusIds.map(
          (
            statusId,
          ): { statusId: string; answers: Record<string, string[]> } => ({
            statusId: statusId,
            answers: { q1: ["eu"] },
          }),
        ),
      },
    ),
  );
}

beforeEach((): void => {
  process.env.SERVICE_AUTH_SECRET = "service-secret";
  const storage = getStorage();
  spyOn(storage.accounts, "getById").mockResolvedValue({
    accountId: "acct_1",
    username: "ada",
    secretHash: "hash",
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  spyOn(storage.agents, "getById").mockResolvedValue({
    accountId: "acct_1",
    agentId: "agent_1",
    name: "agent",
    config: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  spyOn(storage.budgets, "get").mockResolvedValue(null);
  spyOn(storage.agentDeployments, "getByAgentId").mockResolvedValue(null);
  spyOn(runtime, "query").mockImplementation(
    async (name, args): Promise<unknown> => {
      if (name === "getAsyncToolResult") {
        return rows.get((args as { resultId: string }).resultId) ?? null;
      }

      return null;
    },
  );
  spyOn(runtime, "mutate").mockImplementation(
    async (name, args): Promise<unknown> => {
      if (name === "updateAsyncToolResult") {
        return settleWith.get((args as { resultId: string }).resultId) ?? null;
      }

      return true;
    },
  );
  spyOn(ingress, "acceptIngress").mockResolvedValue({
    outcome: "owner",
    ownerGeneration: 2,
  });
  spyOn(workerQueue, "dispatchInProcessWorker").mockImplementation(
    (kind): void => {
      workers.push(kind);
    },
  );
});

afterEach((): void => {
  rows.clear();
  settleWith.clear();
  workers.length = 0;
  delete process.env.SERVICE_AUTH_SECRET;
  spyOn(runtime, "query").mockRestore();
  spyOn(runtime, "mutate").mockRestore();
  spyOn(ingress, "acceptIngress").mockRestore();
  spyOn(workerQueue, "dispatchInProcessWorker").mockRestore();
  resetStorageForTests();
});

describe("answering open questions through the direct API", (): void => {
  test("an unknown or foreign question is a 404 and settles nothing", async (): Promise<void> => {
    rows.set(
      "res_other",
      question("res_other", {
        conversationKey: "acct:acct_1:agent:agent_1:api:other",
      }),
    );

    const unknown = await answer("res_missing");
    const foreign = await answer("res_other");

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: { code: "question_not_found", param: "statusId" },
    });
    expect(foreign.status).toBe(404);
    expect(workers).toEqual([]);
  });

  test("an answered question resumes the conversation", async (): Promise<void> => {
    rows.set("res_1", question("res_1"));
    settleWith.set("res_1", question("res_1", { status: "completed" }));

    const response = await answer("res_1");

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "accepted",
      resultId: "res_1",
      invoked: true,
    });
    expect(workers).toEqual(["direct-api-async-worker"]);
  });

  test("a question someone else already answered is a 409", async (): Promise<void> => {
    rows.set("res_1", question("res_1"));

    const response = await answer("res_1");

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "question_already_answered",
        message: "Questions already answered: res_1",
      },
    });
    expect(workers).toEqual([]);
  });

  test("a settled row that names no account skips the resume", async (): Promise<void> => {
    rows.set("res_1", question("res_1"));
    settleWith.set(
      "res_1",
      question("res_1", { status: "completed", parentEventId: "orphan" }),
    );

    const response = await answer("res_1");

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      resultId: "res_1",
      invoked: false,
    });
    expect(workers).toEqual([]);
  });
});
