import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as ingress from "../../../../apps/core/src/harness/ingress.ts";
import type { IngressCandidate } from "../../../../apps/core/src/harness/ingress.ts";
import * as workerQueue from "../../../../apps/core/src/harness/worker-queue.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";
import {
  getStorage,
  resetStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";
import { coreRequest } from "../../../../apps/core/tests/helpers/http.ts";

const { handler } =
  await import("../../../../apps/core/src/harness/handler.ts");

const admitted: IngressCandidate[] = [];
const workers: string[] = [];
let outcome: Awaited<ReturnType<typeof ingress.acceptIngress>> = {
  outcome: "owner",
  ownerGeneration: 3,
};

function resume(background: boolean): Promise<Response> {
  return handler(
    coreRequest(
      "POST",
      "/v1/runs",
      { authorization: "Bearer service-secret", "x-account-id": "acct_1" },
      {
        agentId: "agent_1",
        eventId: "continue-event",
        conversationKey: "chat",
        continue: true,
        ...(background ? { background: true } : {}),
      },
    ),
  );
}

beforeEach((): void => {
  process.env.SERVICE_AUTH_SECRET = "service-secret";
  process.env.PUBLIC_BASE_URL = "https://api.example.test";
  outcome = { outcome: "owner", ownerGeneration: 3 };
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
  spyOn(runtime, "query").mockResolvedValue(null);
  spyOn(runtime, "mutate").mockResolvedValue(true);
  spyOn(ingress, "acceptIngress").mockImplementation(
    async (candidate): Promise<typeof outcome> => {
      admitted.push(candidate);

      return outcome;
    },
  );
  spyOn(workerQueue, "dispatchInProcessWorker").mockImplementation(
    (kind): void => {
      workers.push(kind);
    },
  );
});

afterEach((): void => {
  admitted.length = 0;
  workers.length = 0;
  delete process.env.SERVICE_AUTH_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  spyOn(runtime, "query").mockRestore();
  spyOn(runtime, "mutate").mockRestore();
  spyOn(ingress, "acceptIngress").mockRestore();
  spyOn(workerQueue, "dispatchInProcessWorker").mockRestore();
  resetStorageForTests();
});

describe("a continue request", (): void => {
  test("admits a follow-up turn and starts it when it owns the conversation", async (): Promise<void> => {
    const response = await resume(true);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      eventId: "continue-event",
      status: "processing",
      requestedMode: "followup",
    });
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({
      eventId: "acct:acct_1:agent:agent_1:api:continue-event",
      conversationKey: "acct:acct_1:agent:agent_1:api:chat",
      requestedMode: "followup",
    });
    expect(JSON.stringify(admitted[0]?.events)).toContain(
      "cut off before it finished",
    );
    expect(workers).toEqual(["direct-api-async-worker"]);
  });

  test("only queues behind a conversation someone else owns", async (): Promise<void> => {
    outcome = { outcome: "queued" };

    const response = await resume(true);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "queued" });
    expect(workers).toEqual([]);
  });
});
