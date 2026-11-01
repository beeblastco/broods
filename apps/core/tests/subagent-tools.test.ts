import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type {
  AgentMessage,
  AgentMessageResult,
} from "../src/harness/tools/utils.ts";
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
const PARENT_CONVERSATION_KEY = scopedDirectConversationKey(
  ACCOUNT_ID,
  "agent_parent",
  "chat",
);

const originalQuery = runtime.query.bind(runtime);
const originalMutate = runtime.mutate.bind(runtime);

afterEach(() => {
  runtime.query = originalQuery;
  runtime.mutate = originalMutate;
});

it("stops its own persistent child", async () => {
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

  expect(
    execute(tools.stop_subagent, {
      taskId: taskId,
      agentId: AGENT_ID,
    }),
  ).resolves.toEqual({
    status: "stopping",
    note: expect.stringContaining("sends no report"),
  });

  expect(mutations.map(({ name }) => name)).toEqual(["stopIngressOwner"]);
  expect(mutations[0]?.args.conversationKey).toBe(conversationKey);
  expect(mutations[0]?.args.expectedOwnerTaskId).toBe(taskId);
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

  expect(
    execute(tools.stop_subagent, {
      taskId: taskId,
      agentId: AGENT_ID,
    }),
  ).resolves.toEqual({ status: "not_running" });
});

it("tells the parent a follow-up queued on a stopped child still reports", async () => {
  const taskId = createSubagentTaskId(PARENT_EVENT_ID);
  spyOn(runtime, "query").mockResolvedValue({
    accountId: ACCOUNT_ID,
    eventId: scopedDirectEventId(ACCOUNT_ID, AGENT_ID, taskId),
    conversationKey: scopedDirectConversationKey(ACCOUNT_ID, AGENT_ID, "q"),
    status: "processing",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: Date.now() + 1_000,
  } as never);
  spyOn(runtime, "mutate").mockResolvedValue({ queuedCount: 1, stopped: true });
  const tools = await subagentTools(PARENT_EVENT_ID);

  expect(
    execute(tools.stop_subagent, { taskId: taskId, agentId: AGENT_ID }),
  ).resolves.toEqual({
    status: "stopping",
    note: expect.stringContaining("1 follow-up turn(s) queued on it still run"),
  });
});

it("rejects another account's task before reading durable state", async () => {
  const foreignTaskId = createSubagentTaskId(
    scopedDirectEventId("account_2", "agent_parent", "event"),
  );
  const query = mock(async () => null);
  runtime.query = query as never;
  const tools = await subagentTools(PARENT_EVENT_ID);

  for (const tool of Object.values(tools)) {
    expect(
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

it("rejects a task another conversation started", async () => {
  const foreignTaskId = createSubagentTaskId(
    scopedDirectEventId(ACCOUNT_ID, "agent_parent", "other-event"),
  );
  const query = spyOn(runtime, "query").mockResolvedValue({
    conversationKey: `${PARENT_CONVERSATION_KEY}-other`,
  } as never);
  const tools = await subagentTools(PARENT_EVENT_ID);

  expect(
    execute(tools.stop_subagent, {
      taskId: foreignTaskId,
      agentId: AGENT_ID,
    }),
  ).rejects.toThrow(`Error: no subagent task found for ${foreignTaskId}`);
  expect(query.mock.calls.map(([name]) => name)).toEqual([
    "getIngressStatusByEventId",
  ]);
});

it("stops a task an earlier turn of this conversation started", async () => {
  const earlierEventId = scopedDirectEventId(
    ACCOUNT_ID,
    "agent_parent",
    "earlier-event",
  );
  const taskId = createSubagentTaskId(earlierEventId);
  const childEventId = scopedDirectEventId(ACCOUNT_ID, AGENT_ID, taskId);
  // The ownership read of the earlier turn's envelope, then the child's row.
  const query = spyOn(runtime, "query")
    .mockResolvedValueOnce({
      conversationKey: PARENT_CONVERSATION_KEY,
    } as never)
    .mockResolvedValueOnce({
      accountId: ACCOUNT_ID,
      eventId: childEventId,
      conversationKey: scopedDirectConversationKey(
        ACCOUNT_ID,
        AGENT_ID,
        "earlier",
      ),
      status: "processing",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      expiresAt: Date.now() + 1_000,
    } as never);
  spyOn(runtime, "mutate").mockResolvedValue({ queuedCount: 0, stopped: true });
  const tools = await subagentTools(PARENT_EVENT_ID);

  expect(
    await execute(tools.stop_subagent, {
      taskId: taskId,
      agentId: AGENT_ID,
    }),
  ).toMatchObject({ status: "stopping" });
  expect(query.mock.calls[0]?.[1]).toMatchObject({ eventId: earlierEventId });
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
    expect(
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

  expect(
    execute(tools.stop_subagent, {
      taskId: taskId,
      agentId: AGENT_ID,
    }),
  ).rejects.toThrow(`Error: no subagent task found for ${taskId}`);
});

it("message-agents waits on the parent once a turn, notes without a wait, and reaches children by address", async () => {
  const { default: messageAgents } =
    await import("../src/harness/tools/message-agents.tool.ts");
  const asked: AgentMessage[] = [];
  const sent: Array<{ to: string; message: AgentMessage }> = [];
  const tools = messageAgents({
    parent: {
      ask: (message: AgentMessage): boolean => {
        if (asked.length > 0) return false;
        asked.push(message);

        return true;
      },
      note: (message: AgentMessage): AgentMessageResult => ({
        status: "delivered",
        exchangeId: message.exchangeId,
        note: "noted",
      }),
    },
    messageChild: async (
      to: string,
      message: AgentMessage,
    ): Promise<AgentMessageResult> => {
      sent.push({ to: to, message: message });

      return { status: "resumed", exchangeId: message.exchangeId, note: "" };
    },
  });
  const tool = tools["message-agents"];

  expect(
    execute(tool, { to: "parent", text: " Use staging? ", wait: true }),
  ).resolves.toMatchObject({ status: "delivered" });
  expect(asked[0]).toMatchObject({
    text: "Use staging?",
    followUp: false,
    waitSeconds: 600,
  });
  expect(
    execute(tool, { to: "parent", text: "And prod?", wait: true }),
  ).rejects.toThrow("already wait");
  expect(
    execute(tool, { to: "parent", text: "halfway there" }),
  ).resolves.toMatchObject({ status: "delivered", note: "noted" });
  expect(execute(tool, { to: "parent", text: "  " })).rejects.toThrow(
    "non-empty text",
  );

  await execute(tool, {
    to: "agent_child/subagent-persistent-x",
    text: "status?",
    wait: true,
    timeoutSeconds: 99_999,
    followUp: "ex_1234",
  });
  expect(sent[0]).toEqual({
    to: "agent_child/subagent-persistent-x",
    message: {
      text: "status?",
      exchangeId: "ex_1234",
      followUp: true,
      waitSeconds: 3600,
    },
  });
});

async function subagentTools(parentEventId: string) {
  const { default: stop } =
    await import("../src/harness/tools/stop-subagent.tool.ts");
  const context = {
    accountId: ACCOUNT_ID,
    eventId: parentEventId,
    conversationKey: PARENT_CONVERSATION_KEY,
  };

  return { stop_subagent: stop(context).stop_subagent! };
}

function execute(tool: unknown, input: unknown): Promise<unknown> {
  return (
    tool as { execute: (input: unknown, options: unknown) => Promise<unknown> }
  ).execute(input, { messages: [] });
}
