import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AsyncToolResultRecord } from "../../../../apps/core/src/harness/async-tool-result.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";
import type { AgentRecord } from "../../../../apps/core/src/shared/domain/agents.ts";
import {
  getStorage,
  resetStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";
import { coreRequest } from "../../../../apps/core/tests/helpers/http.ts";

const { handler } =
  await import("../../../../apps/core/src/harness/handler.ts");

const SCOPED_PARENT = "acct:acct_1:agent:agent_1:api:event_0";

let parentEventId = SCOPED_PARENT;
let agent: AgentRecord | null = null;
const updates: unknown[] = [];

function row(): AsyncToolResultRecord {
  return {
    resultId: "job_1",
    parentEventId: parentEventId,
    conversationKey: "acct:acct_1:agent:agent_1:api:chat",
    toolName: "sandbox_job",
    toolCallId: "call_1",
    input: {},
    status: "processing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: Date.now() + 3_600_000,
  };
}

function complete(): Promise<Response> {
  return handler(
    coreRequest(
      "POST",
      "/v1/sandbox-jobs/job_1/complete",
      { "x-job-token": "token-1" },
      { status: "completed", response: { out: "fine" } },
    ),
  );
}

beforeEach((): void => {
  const storage = getStorage();
  spyOn(storage.agents, "getById").mockImplementation(
    async (): Promise<AgentRecord | null> => agent,
  );
  spyOn(storage.sandboxConfigs, "getById").mockResolvedValue(null);
  spyOn(runtime, "query").mockImplementation(async (name): Promise<unknown> => {
    if (name === "getAsyncToolResult") return row();
    if (name === "getAsyncToolToken") return true;

    return null;
  });
  spyOn(runtime, "mutate").mockImplementation(
    async (name, args): Promise<unknown> => {
      if (name !== "updateAsyncToolResult") return null;
      updates.push(args);

      return { ...row(), parentEventId: "orphan", status: "completed" };
    },
  );
});

afterEach((): void => {
  updates.length = 0;
  agent = null;
  parentEventId = SCOPED_PARENT;
  spyOn(runtime, "query").mockRestore();
  spyOn(runtime, "mutate").mockRestore();
  resetStorageForTests();
});

describe("a sandbox job callback", (): void => {
  test("settles with no extra secrets when the row names no agent", async (): Promise<void> => {
    parentEventId = "orphan";

    const response = await complete();

    expect(response.status).toBe(202);
    expect(updates).toMatchObject([
      { resultId: "job_1", status: "completed", response: { out: "fine" } },
    ]);
  });

  test("settles when the agent's sandbox no longer resolves", async (): Promise<void> => {
    agent = {
      accountId: "acct_1",
      agentId: "agent_1",
      name: "agent",
      config: { sandboxes: ["sb_missing"] },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };

    const response = await complete();

    expect(response.status).toBe(202);
    expect(updates).toHaveLength(1);
  });
});
