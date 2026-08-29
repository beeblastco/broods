/**
 * Model-facing persistent subagent tool authorization and routing.
 */

import { afterEach, expect, it, mock } from "bun:test";
import type { Session } from "../src/harness/session.ts";
import { runtime } from "../src/shared/convex/runtime.ts";
import {
  createSubagentTaskId,
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../src/shared/runtime-keys.ts";

const ACCOUNT_ID = "account_1";
const AGENT_ID = "agent_child";
const PARENT_EVENT_ID = scopedDirectEventId(
  ACCOUNT_ID,
  "agent_parent",
  "parent-event",
);

const originalQuery = runtime.query;
const originalMutate = runtime.mutate;

afterEach(() => {
  runtime.query = originalQuery;
  runtime.mutate = originalMutate;
});

it("checks, steers, continues, and stops its own persistent child", async () => {
  const taskId = createSubagentTaskId(PARENT_EVENT_ID);
  const childEventId = scopedDirectEventId(ACCOUNT_ID, AGENT_ID, taskId);
  const conversationKey = scopedDirectConversationKey(
    ACCOUNT_ID,
    AGENT_ID,
    "subagent-persistent-test",
  );
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  runtime.query = mock(async (_name, args) =>
    args.eventId === childEventId
      ? {
          accountId: ACCOUNT_ID,
          eventId: childEventId,
          conversationKey: conversationKey,
          status: "processing",
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:00.000Z",
          expiresAt: Date.now() + 1_000,
        }
      : null,
  ) as never;
  runtime.mutate = mock(async (name, args) => {
    mutations.push({ name: name, args: args });

    return name === "stopIngressOwner"
      ? { stopped: true, queuedCount: 0 }
      : { outcome: "queued" };
  }) as never;
  const tools = await subagentTools(PARENT_EVENT_ID);

  await expect(
    execute(tools.get_subagent_status, {
      taskId: taskId,
      agentId: AGENT_ID,
    }),
  ).resolves.toEqual({ status: "processing" });
  await expect(
    execute(tools.update_subagent, {
      taskId: taskId,
      agentId: AGENT_ID,
      mode: "steer",
      message: "change direction",
    }),
  ).resolves.toEqual({ mode: "steer", status: "queued" });
  await expect(
    execute(tools.update_subagent, {
      taskId: taskId,
      agentId: AGENT_ID,
      mode: "continue",
      message: "then summarize",
    }),
  ).resolves.toEqual({ mode: "continue", status: "queued" });
  await expect(
    execute(tools.stop_subagent, {
      taskId: taskId,
      agentId: AGENT_ID,
    }),
  ).resolves.toEqual({ status: "stopping" });

  expect(mutations.map(({ name }) => name)).toEqual([
    "acceptIngress",
    "acceptIngress",
    "stopIngressOwner",
  ]);
  expect(mutations[0]?.args.requestedMode).toBe("steer");
  expect(mutations[0]?.args.activeOwnerOnly).toBe(true);
  expect(mutations[0]?.args.expectedOwnerTaskId).toBe(taskId);
  expect(mutations[1]?.args.requestedMode).toBe("followup");
  expect(mutations[1]?.args.activeOwnerOnly).toBe(true);
  expect(mutations[1]?.args.expectedOwnerTaskId).toBe(taskId);
  expect(mutations[2]?.args.conversationKey).toBe(conversationKey);
  expect(mutations[2]?.args.expectedOwnerTaskId).toBe(taskId);
});

it("preserves a completed subagent response as structured output", async () => {
  const taskId = createSubagentTaskId(PARENT_EVENT_ID);
  const childEventId = scopedDirectEventId(ACCOUNT_ID, AGENT_ID, taskId);
  const response = {
    summary: "done",
    sources: ["primary", "secondary"],
  };
  runtime.query = mock(async () => ({
    accountId: ACCOUNT_ID,
    eventId: childEventId,
    conversationKey: scopedDirectConversationKey(
      ACCOUNT_ID,
      AGENT_ID,
      "subagent-persistent-test",
    ),
    status: "completed",
    response: response,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: Date.now() + 1_000,
  })) as never;
  const tools = await subagentTools(PARENT_EVENT_ID);

  expect(
    await execute(tools.get_subagent_status, {
      taskId: taskId,
      agentId: AGENT_ID,
    }),
  ).toEqual({ status: "completed", response: response });
});

it("does not take ownership when a child finishes during an update", async () => {
  const taskId = createSubagentTaskId(PARENT_EVENT_ID);
  const childEventId = scopedDirectEventId(ACCOUNT_ID, AGENT_ID, taskId);
  const conversationKey = scopedDirectConversationKey(
    ACCOUNT_ID,
    AGENT_ID,
    "subagent-persistent-test",
  );
  runtime.query = mock(async () => ({
    accountId: ACCOUNT_ID,
    eventId: childEventId,
    conversationKey: conversationKey,
    status: "processing",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: Date.now() + 1_000,
  })) as never;
  runtime.mutate = mock(async () => ({ outcome: "not_running" })) as never;
  const tools = await subagentTools(PARENT_EVENT_ID);

  await expect(
    execute(tools.update_subagent, {
      taskId: taskId,
      agentId: AGENT_ID,
      mode: "steer",
      message: "change direction",
    }),
  ).resolves.toEqual({ status: "not_running" });
});

it("dispatches recovered queued work while rejecting a late update", async () => {
  const taskId = createSubagentTaskId(PARENT_EVENT_ID);
  const agentId = `virtual_subagent_${taskId}`;
  const childEventId = scopedDirectEventId(ACCOUNT_ID, agentId, taskId);
  const conversationKey = scopedDirectConversationKey(
    ACCOUNT_ID,
    agentId,
    "subagent-persistent-test",
  );
  const recovered = {
    eventId: scopedDirectEventId(ACCOUNT_ID, agentId, "queued"),
    events: [{ role: "user", content: "queued" }],
    delivery: {
      kind: "async",
      publicEventId: "queued",
      publicConversationKey: "subagent-persistent-test",
      statusUrl: "",
    },
    requestedMode: "followup",
    appliedMode: "followup",
    appliedToEventId: scopedDirectEventId(ACCOUNT_ID, agentId, "queued"),
    contributingEventIds: [scopedDirectEventId(ACCOUNT_ID, agentId, "queued")],
    ownerGeneration: 2,
  } as const;
  runtime.query = mock(async () => ({
    accountId: ACCOUNT_ID,
    eventId: childEventId,
    conversationKey: conversationKey,
    status: "processing",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: Date.now() + 1_000,
  })) as never;
  runtime.mutate = mock(async () => ({
    outcome: "not_running",
    recovered: recovered,
  })) as never;
  const dispatchAppliedIngress = mock(
    async (_scope: unknown, _ingress: unknown): Promise<void> => {},
  );
  const tools = await subagentTools(PARENT_EVENT_ID, dispatchAppliedIngress);

  await expect(
    execute(tools.update_subagent, {
      taskId: taskId,
      agentId: agentId,
      mode: "continue",
      message: "continue",
    }),
  ).resolves.toEqual({ status: "not_running" });
  expect(dispatchAppliedIngress).toHaveBeenCalledTimes(1);
  expect(dispatchAppliedIngress.mock.calls[0]?.[1]).toEqual(recovered);
});

it("reports a late stop as not running without trusting stale task status", async () => {
  const taskId = createSubagentTaskId(PARENT_EVENT_ID);
  const childEventId = scopedDirectEventId(ACCOUNT_ID, AGENT_ID, taskId);
  const conversationKey = scopedDirectConversationKey(
    ACCOUNT_ID,
    AGENT_ID,
    "subagent-persistent-test",
  );
  runtime.query = mock(async () => ({
    accountId: ACCOUNT_ID,
    eventId: childEventId,
    conversationKey: conversationKey,
    status: "completed",
    response: "done",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: Date.now() + 1_000,
  })) as never;
  runtime.mutate = mock(async () => ({
    queuedCount: 0,
    stopped: false,
  })) as never;
  const tools = await subagentTools(PARENT_EVENT_ID);

  await expect(
    execute(tools.stop_subagent, {
      taskId: taskId,
      agentId: AGENT_ID,
    }),
  ).resolves.toEqual({ status: "not_running" });
});

it("rejects another parent's task before reading durable state", async () => {
  const foreignTaskId = createSubagentTaskId(
    scopedDirectEventId(ACCOUNT_ID, "other_parent", "event"),
  );
  const query = mock(async () => null);
  runtime.query = query as never;
  const tools = await subagentTools(PARENT_EVENT_ID);

  for (const tool of Object.values(tools)) {
    await expect(
      execute(tool, {
        taskId: foreignTaskId,
        agentId: AGENT_ID,
        mode: "steer",
        message: "change direction",
      }),
    ).rejects.toThrow(`Error: no subagent task found for ${foreignTaskId}`);
  }
  expect(query).not.toHaveBeenCalled();
});

it("rejects a sibling task and an agent mismatch as not found", async () => {
  const taskId = createSubagentTaskId(PARENT_EVENT_ID);
  runtime.query = mock(async () => ({
    accountId: ACCOUNT_ID,
    eventId: scopedDirectEventId(ACCOUNT_ID, AGENT_ID, taskId),
    conversationKey: scopedDirectConversationKey(
      ACCOUNT_ID,
      AGENT_ID,
      "subagent-persistent-test",
    ),
    status: "processing",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: Date.now() + 1_000,
  })) as never;
  const tools = await subagentTools(PARENT_EVENT_ID);

  for (const tool of Object.values(tools)) {
    await expect(
      execute(tool, {
        taskId: taskId,
        agentId: "agent_sibling",
        mode: "steer",
        message: "change direction",
      }),
    ).rejects.toThrow(`Error: no subagent task found for ${taskId}`);
  }
});

it("rejects a durable record with a mismatched account", async () => {
  const taskId = createSubagentTaskId(PARENT_EVENT_ID);
  runtime.query = mock(async () => ({
    accountId: "account_other",
    eventId: scopedDirectEventId(ACCOUNT_ID, AGENT_ID, taskId),
    conversationKey: scopedDirectConversationKey(
      ACCOUNT_ID,
      AGENT_ID,
      "subagent-persistent-test",
    ),
    status: "processing",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: Date.now() + 1_000,
  })) as never;
  const tools = await subagentTools(PARENT_EVENT_ID);

  await expect(
    execute(tools.stop_subagent, {
      taskId: taskId,
      agentId: AGENT_ID,
    }),
  ).rejects.toThrow(`Error: no subagent task found for ${taskId}`);
});

async function subagentTools(
  parentEventId: string,
  dispatchAppliedIngress = mock(
    async (_scope: unknown, _ingress: unknown): Promise<void> => {},
  ),
) {
  const [{ default: getStatus }, { default: update }, { default: stop }] =
    await Promise.all([
      import("../src/harness/tools/get-subagent-status.tool.ts"),
      import("../src/harness/tools/update-subagent.tool.ts"),
      import("../src/harness/tools/stop-subagent.tool.ts"),
    ]);
  const context = {
    accountId: ACCOUNT_ID,
    agentConfig: {},
    dispatchAppliedIngress: dispatchAppliedIngress,
    eventId: parentEventId,
    // The update tool reads only the session's dispatch scope fields.
    session: {
      endpointId: undefined,
      projectSlug: undefined,
      stageSlug: undefined,
    } as unknown as Session,
  };

  return {
    get_subagent_status: getStatus(context).get_subagent_status!,
    update_subagent: update(context).update_subagent!,
    stop_subagent: stop(context).stop_subagent!,
  };
}

function execute(tool: unknown, input: unknown): Promise<unknown> {
  return (
    tool as { execute: (input: unknown, options: unknown) => Promise<unknown> }
  ).execute(input, { messages: [] });
}
