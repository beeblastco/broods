import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as harness from "../../../../apps/core/src/harness/harness.ts";
import * as ingress from "../../../../apps/core/src/harness/ingress.ts";
import type { AsyncToolResultRecord } from "../../../../apps/core/src/harness/async-tool-result.ts";
import type { ChannelInboundEvent } from "../../../../apps/core/src/harness/integrations.ts";
import { Session } from "../../../../apps/core/src/harness/session.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";
import {
  getStorage,
  resetStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";

const { handleChannelRequest } =
  await import("../../../../apps/core/src/harness/handler.ts");
const { drainInProcessWorkers } =
  await import("../../../../apps/core/src/harness/worker-queue.ts");

type Stream = Awaited<ReturnType<typeof harness.runAgentLoop>>;
type Click = NonNullable<ChannelInboundEvent["answer"]>;

const CONVERSATION = "acct:acct_1:agent:agent_1:tg:1";

const sent: string[] = [];
const settles: unknown[] = [];
let pending: AsyncToolResultRecord[] = [];
let loop: ReturnType<typeof spyOn<typeof harness, "runAgentLoop">>;

function question(resultId: string): AsyncToolResultRecord {
  return {
    resultId: resultId,
    parentEventId: "orphan",
    conversationKey: CONVERSATION,
    toolName: "ask_questions",
    toolCallId: `call_${resultId}`,
    input: {
      questions: [
        {
          id: "q1",
          header: "Region",
          question: "Which?",
          options: [{ label: "eu" }, { label: "us" }],
        },
      ],
      blocking: true,
      answerBy: new Date(Date.now() + 3_600_000).toISOString(),
    },
    status: "processing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: Date.now() + 3_600_000,
  };
}

function message(text: string, answer?: Click): ChannelInboundEvent {
  return {
    accountId: "acct_1",
    agentId: "agent_1",
    eventId: "channel-event-1",
    conversationKey: CONVERSATION,
    content: text,
    events: [{ role: "user", content: text }],
    channelName: "telegram",
    source: { chatId: 1 },
    agentConfig: {},
    ...(answer ? { answer: answer } : {}),
    channel: {
      sendText: async (reply): Promise<void> => {
        sent.push(reply);
      },
      sendTyping: async (): Promise<void> => {},
      reactToMessage: async (): Promise<void> => {},
    },
  } as ChannelInboundEvent;
}

async function receive(event: ChannelInboundEvent): Promise<void> {
  await handleChannelRequest(event);
  await drainInProcessWorkers();
}

beforeEach((): void => {
  const storage = getStorage();
  spyOn(storage.accounts, "getById").mockResolvedValue({
    accountId: "acct_1",
    username: "ada",
    secretHash: "hash",
    status: "active",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  spyOn(storage.budgets, "get").mockResolvedValue(null);
  spyOn(runtime, "mutate").mockImplementation(
    async (name, args): Promise<unknown> => {
      if (name === "updateAsyncToolResult") {
        settles.push(args);

        return null;
      }

      return null;
    },
  );
  spyOn(runtime, "query").mockImplementation(
    async (name, args): Promise<unknown> => {
      if (name === "listPendingAsyncToolResults") return pending;
      if (name === "getAsyncToolResult") {
        const id = (args as { resultId: string }).resultId;

        return pending.find((row): boolean => row.resultId === id) ?? null;
      }

      return [];
    },
  );
  spyOn(ingress, "acceptIngress").mockResolvedValue({
    outcome: "owner",
    ownerGeneration: 1,
  });
  spyOn(ingress, "settleIngress").mockResolvedValue(1);
  spyOn(Session.prototype, "assertCurrentOwner").mockResolvedValue();
  spyOn(Session.prototype, "createTurnContext").mockImplementation(
    async (): ReturnType<Session["createTurnContext"]> => ({
      messages: [{ role: "user", content: "hi" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    }),
  );
  loop = spyOn(harness, "runAgentLoop").mockImplementation(
    async (): Promise<Stream> =>
      ({
        traceId: (): undefined => undefined,
        consumeStream: async (): Promise<void> => {},
        questionSummaries: (): [] => [],
        didFail: (): boolean => false,
        yielded: (): boolean => false,
        failureText: (): null => null,
      }) as unknown as Stream,
  );
});

afterEach((): void => {
  sent.length = 0;
  settles.length = 0;
  pending = [];
  spyOn(harness, "runAgentLoop").mockRestore();
  spyOn(runtime, "query").mockRestore();
  spyOn(runtime, "mutate").mockRestore();
  resetStorageForTests();
});

describe("a channel message while a question is open", (): void => {
  test("a click on a closed question says so and runs nothing", async (): Promise<void> => {
    await receive(
      message("eu", { statusId: "res_gone", questionIndex: 0, optionIndex: 0 }),
    );

    expect(sent).toEqual(["That question is no longer open."]);
    expect(loop).not.toHaveBeenCalled();
  });

  test("a click on a missing option is refused the same way", async (): Promise<void> => {
    pending = [question("res_1")];

    await receive(
      message("?", { statusId: "res_1", questionIndex: 0, optionIndex: 9 }),
    );

    expect(sent).toEqual(["That question is no longer open."]);
    expect(settles).toEqual([]);
  });

  test("blank text is not an answer and the message runs as a turn", async (): Promise<void> => {
    pending = [question("res_1")];

    await receive(message("   "));

    expect(settles).toEqual([]);
    expect(loop).toHaveBeenCalledTimes(1);
  });

  test("a question another writer settled first lets the message run", async (): Promise<void> => {
    pending = [question("res_1")];

    await receive(message("eu"));

    expect(settles).toHaveLength(1);
    expect(loop).toHaveBeenCalledTimes(1);
  });

  test("with nothing open the message runs as a turn", async (): Promise<void> => {
    await receive(message("hello"));

    expect(settles).toEqual([]);
    expect(loop).toHaveBeenCalledTimes(1);
  });
});
