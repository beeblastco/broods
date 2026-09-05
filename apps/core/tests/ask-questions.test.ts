/**
 * ask_questions tests.
 * Cover the row the tool leaves behind, how the prompt reaches a channel, and
 * how a typed reply, a button click or an expired prompt resolves against it.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ToolExecuteFunction, ToolSet } from "ai";
import type { AsyncToolResultRecord } from "../src/harness/async-tool-result.ts";
import {
  answersFromChoice,
  answersFromText,
  formatQuestionsText,
  listOpenQuestions,
  NO_ANSWER_ERROR,
  openQuestion,
  type PendingQuestionInput,
} from "../src/harness/questions.ts";
import askQuestionsTool, {
  type AskQuestionsInput,
  type AskQuestionsOutput,
} from "../src/harness/tools/ask-questions.tool.ts";
import type { ChannelToolContext } from "../src/harness/tools/channel.tool.ts";
import type {
  ChannelQuestion,
  ChannelQuestionPrompt,
} from "../src/shared/channels.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

const CONVERSATION_KEY = "acct:a:agent:b:conv";
const QUESTION: ChannelQuestion = {
  id: "deploy_target",
  header: "Target",
  question: "Which stage should this go to?",
  options: [
    { label: "dev", description: "current default" },
    { label: "prod" },
  ],
};
const PENDING: PendingQuestionInput = {
  questions: [QUESTION],
  blocking: false,
  answerBy: new Date(Date.now() + 60_000).toISOString(),
};

interface RecordedMutation {
  name: string;
  args: Record<string, unknown>;
}

const originalMutate = runtime.mutate;
const originalQuery = runtime.query;
const mutations: RecordedMutation[] = [];

afterEach((): void => {
  runtime.mutate = originalMutate;
  runtime.query = originalQuery;
  mutations.length = 0;
});

describe("ask_questions tool", () => {
  it("leaves a sealed question row and posts the numbered prompt", async () => {
    stubMutations();
    const sendText = mock(async (_text: string): Promise<void> => {});
    const execute = toolExecute(
      askQuestionsTool({
        conversationKey: CONVERSATION_KEY,
        eventId: "event-1",
        delivery: { kind: "async" },
        channel: channelContext({ sendText: sendText }),
      }),
    );

    const output = await execute({ questions: [QUESTION] });

    expect(output.blocking).toBe(false);
    expect(output.statusId).toMatch(/^async_tool_/);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.name).toBe("createAsyncToolResult");
    expect(mutations[0]!.args).toMatchObject({
      resultId: output.statusId,
      parentEventId: `event-1:async-question:${output.statusId}`,
      conversationKey: CONVERSATION_KEY,
      toolName: "ask_questions",
      delivery: { kind: "async" },
      sealed: true,
      input: {
        questions: [QUESTION],
        blocking: false,
        answerBy: output.answerBy,
      },
    });
    expect(sendText.mock.calls).toEqual([
      ["Which stage should this go to?\n1. dev - current default\n2. prod"],
    ]);
  });

  it("hands the prompt to a channel that renders buttons and reports a blocking call", async () => {
    stubMutations();
    const sendText = mock(async (_text: string): Promise<void> => {});
    const sendQuestions = mock(
      async (_prompt: ChannelQuestionPrompt): Promise<void> => {},
    );
    const blocked: string[] = [];
    const execute = toolExecute(
      askQuestionsTool({
        conversationKey: CONVERSATION_KEY,
        eventId: "event-1",
        channel: channelContext({
          sendText: sendText,
          sendQuestions: sendQuestions,
        }),
        onBlockingQuestion: (question): void => {
          blocked.push(question.statusId);
        },
      }),
    );

    const output = await execute({ questions: [QUESTION], blocking: true });

    expect(output.blocking).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendQuestions.mock.calls[0]![0]).toMatchObject({
      statusId: output.statusId,
      questions: [QUESTION],
    });
    expect(blocked).toEqual([output.statusId]);
  });

  it("rejects a malformed prompt before touching storage", async () => {
    stubMutations();
    const execute = toolExecute(
      askQuestionsTool({
        conversationKey: CONVERSATION_KEY,
        eventId: "event-1",
      }),
    );

    await expect(
      execute({
        questions: [{ ...QUESTION, options: [{ label: "only one" }] }],
      }),
    ).rejects.toThrow("needs 2 to 4 options");
    await expect(execute({ questions: [QUESTION, QUESTION] })).rejects.toThrow(
      "is used twice",
    );
    expect(mutations).toHaveLength(0);
  });

  it("fails the row when the outbound hook blocks the prompt", async () => {
    stubMutations();
    const execute = toolExecute(
      askQuestionsTool({
        conversationKey: CONVERSATION_KEY,
        eventId: "event-1",
        channel: channelContext({ transformText: async () => null }),
      }),
    );

    await expect(execute({ questions: [QUESTION] })).rejects.toThrow(
      "blocked by the outbound message hook",
    );
    expect(mutations.at(-1)?.args).toMatchObject({ status: "failed" });
  });
});

describe("question answers", () => {
  it("reads a typed reply as an option number, a label, or free text", () => {
    expect(answersFromText(PENDING, "2")?.answers).toEqual({
      deploy_target: ["prod"],
    });
    expect(answersFromText(PENDING, " Dev ")?.answers).toEqual({
      deploy_target: ["dev"],
    });
    expect(answersFromText(PENDING, "1")?.note).toBeUndefined();
  });

  it("takes free text only when the question allows it", () => {
    expect(answersFromText(PENDING, "staging please")).toBeUndefined();
    expect(
      answersFromText(
        { ...PENDING, questions: [{ ...QUESTION, allowFreeText: true }] },
        "staging please",
      )?.answers,
    ).toEqual({ deploy_target: ["staging please"] });
  });

  it("says so when a typed reply only answers the first of several", () => {
    const result = answersFromText(
      { ...PENDING, questions: [QUESTION, { ...QUESTION, id: "second" }] },
      "1",
    );

    expect(result?.answers).toEqual({ deploy_target: ["dev"] });
    expect(result?.note).toContain("first question only");
  });

  it("resolves a button click by position and rejects a stale one", () => {
    const click = {
      statusId: "async_tool_1",
      questionIndex: 0,
      optionIndex: 1,
    };

    expect(answersFromChoice(PENDING, click)).toEqual({
      deploy_target: ["prod"],
    });
    expect(
      answersFromChoice(PENDING, { ...click, questionIndex: 3 }),
    ).toBeUndefined();
  });

  it("only opens a processing question row from its own conversation", () => {
    const row = questionRow("async_tool_1", PENDING);

    expect(openQuestion(row, CONVERSATION_KEY)?.pending).toEqual(PENDING);
    expect(openQuestion(row, "acct:a:agent:b:other")).toBeUndefined();
    expect(
      openQuestion({ ...row, status: "completed" }, CONVERSATION_KEY),
    ).toBeUndefined();
    expect(openQuestion(null, CONVERSATION_KEY)).toBeUndefined();
  });

  it("expires a prompt nobody answered in time and keeps the rest open", async () => {
    stubMutations();
    const stale = questionRow("async_tool_old", {
      ...PENDING,
      answerBy: new Date(Date.now() - 1000).toISOString(),
    });
    const fresh = questionRow("async_tool_new", PENDING);
    runtime.query = mock(async () => [stale, fresh]) as never;

    const open = await listOpenQuestions(CONVERSATION_KEY);
    await Promise.resolve();

    expect(open.map((question) => question.record.resultId)).toEqual([
      "async_tool_new",
    ]);
    expect(mutations).toEqual([
      {
        name: "updateAsyncToolResult",
        args: expect.objectContaining({
          resultId: "async_tool_old",
          status: "failed",
          error: NO_ANSWER_ERROR,
        }),
      },
    ]);
  });

  it("renders the free-text hint only when the question allows it", () => {
    expect(formatQuestionsText([QUESTION])).not.toContain("your own answer");
    expect(
      formatQuestionsText([{ ...QUESTION, allowFreeText: true }]),
    ).toContain("Or reply with your own answer.");
  });
});

function channelContext(
  overrides: Partial<ChannelToolContext["actions"]> & {
    transformText?: ChannelToolContext["transformText"];
  } = {},
): ChannelToolContext {
  const { transformText, ...actions } = overrides;

  return {
    channelName: "telegram",
    transformText: transformText ?? (async (text): Promise<string> => text),
    actions: {
      sendText: async (): Promise<void> => {},
      sendTyping: async (): Promise<void> => {},
      reactToMessage: async (): Promise<void> => {},
      ...actions,
    },
  };
}

function questionRow(
  resultId: string,
  input: PendingQuestionInput,
): AsyncToolResultRecord {
  const now = new Date().toISOString();

  return {
    resultId: resultId,
    parentEventId: `event-1:async-question:${resultId}`,
    conversationKey: CONVERSATION_KEY,
    toolName: "ask_questions",
    toolCallId: "call-1",
    input: input,
    status: "processing",
    createdAt: now,
    updatedAt: now,
    expiresAt: 0,
  };
}

function stubMutations(): void {
  runtime.mutate = mock(
    async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<boolean | null> => {
      mutations.push({ name: name, args: args });

      return name === "createAsyncToolResult" ? true : null;
    },
  ) as never;
}

function toolExecute(
  tools: ToolSet,
): (input: AskQuestionsInput) => Promise<AskQuestionsOutput> {
  const execute = tools.ask_questions!.execute as ToolExecuteFunction<
    AskQuestionsInput,
    AskQuestionsOutput,
    Record<string, unknown>
  >;

  return (input): Promise<AskQuestionsOutput> =>
    Promise.resolve(
      execute(input, {
        toolCallId: "call-1",
        messages: [],
        context: {},
      }) as Promise<AskQuestionsOutput>,
    );
}
