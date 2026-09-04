/**
 * ask_questions tests.
 * Cover the row the tool leaves behind, how the prompt reaches a channel, and
 * how a typed reply, a button click or an expired prompt resolves against it.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ToolExecuteFunction, ToolSet } from "ai";
import type { ChannelToolContext } from "../src/harness/tools/channel.tool.ts";
import askQuestionsTool, {
  type AskQuestionsInput,
  type AskQuestionsOutput,
} from "../src/harness/tools/ask-questions.tool.ts";
import type { AsyncToolResultRecord } from "../src/harness/async-tool-result.ts";
import {
  answersFromChoice,
  answersFromText,
  formatQuestionsText,
  listOpenQuestions,
  NO_ANSWER_ERROR,
  type PendingQuestionInput,
} from "../src/harness/questions.ts";
import type {
  ChannelQuestion,
  ChannelQuestionPrompt,
} from "../src/shared/channels.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

const originalMutate = runtime.mutate;
const originalQuery = runtime.query;
const mutations: { name: string; args: Record<string, unknown> }[] = [];

const QUESTION: ChannelQuestion = {
  id: "deploy_target",
  header: "Target",
  question: "Which stage should this go to?",
  options: [
    { label: "dev", description: "current default" },
    { label: "prod" },
  ],
};

afterEach(() => {
  runtime.mutate = originalMutate;
  runtime.query = originalQuery;
  mutations.length = 0;
});

describe("ask_questions tool", () => {
  it("leaves a sealed question row and posts the numbered prompt", async () => {
    stubMutations();
    const sendText = mock(async (_text: string) => {});
    const execute = toolExecute(
      askQuestionsTool({
        conversationKey: "acct:a:agent:b:conv",
        eventId: "event-1",
        delivery: { kind: "async" },
        channel: channelContext({ sendText: sendText }),
      }),
    );

    const output = await execute({ questions: [QUESTION] });

    expect(output.status).toBe("asked");
    expect(output.blocking).toBe(false);
    expect(output.statusId).toMatch(/^async_tool_/);
    const created = mutations.find((m) => m.name === "createAsyncToolResult");
    expect(created?.args).toMatchObject({
      resultId: output.statusId,
      parentEventId: `event-1:async-question:${output.statusId}`,
      conversationKey: "acct:a:agent:b:conv",
      toolName: "ask_questions",
      delivery: { kind: "async" },
    });
    const input = created?.args.input as PendingQuestionInput;
    expect(input.kind).toBe("question");
    expect(input.answerKey).toHaveLength(8);
    expect(input.blocking).toBe(false);
    expect(mutations.some((m) => m.name === "sealAsyncToolGroup")).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]![0]).toBe(
      "Which stage should this go to?\n1. dev - current default\n2. prod",
    );
  });

  it("hands the prompt to a channel that renders buttons", async () => {
    stubMutations();
    const sendText = mock(async (_text: string) => {});
    const sendQuestions = mock(async (_prompt: ChannelQuestionPrompt) => {});
    const execute = toolExecute(
      askQuestionsTool({
        conversationKey: "acct:a:agent:b:conv",
        eventId: "event-1",
        channel: channelContext({
          sendText: sendText,
          sendQuestions: sendQuestions,
        }),
      }),
    );

    const output = await execute({ questions: [QUESTION], blocking: true });

    expect(output.blocking).toBe(true);
    expect(output.note).toContain("End your turn now");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendQuestions).toHaveBeenCalledTimes(1);
    const prompt = sendQuestions.mock.calls[0]![0];
    expect(prompt.questions).toEqual([QUESTION]);
    const created = mutations.find((m) => m.name === "createAsyncToolResult");
    expect((created?.args.input as PendingQuestionInput).answerKey).toBe(
      prompt.answerKey,
    );
  });

  it("rejects a malformed prompt before touching storage", async () => {
    stubMutations();
    const execute = toolExecute(
      askQuestionsTool({
        conversationKey: "acct:a:agent:b:conv",
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
        conversationKey: "acct:a:agent:b:conv",
        eventId: "event-1",
        channel: channelContext({ transformText: async () => null }),
      }),
    );

    await expect(execute({ questions: [QUESTION] })).rejects.toThrow(
      "blocked by the outbound message hook",
    );
    const failed = mutations.find(
      (m) => m.name === "updateAsyncToolResult" && m.args.status === "failed",
    );
    expect(failed).toBeDefined();
  });
});

describe("question answers", () => {
  const pending: PendingQuestionInput = {
    kind: "question",
    answerKey: "abc12345",
    questions: [QUESTION],
    blocking: false,
    answerBy: new Date(Date.now() + 60_000).toISOString(),
  };

  it("reads a typed reply as an option number, a label, or free text", () => {
    expect(answersFromText(pending, "2").answers).toEqual({
      deploy_target: ["prod"],
    });
    expect(answersFromText(pending, " Dev ").answers).toEqual({
      deploy_target: ["dev"],
    });
    expect(answersFromText(pending, "staging please").answers).toEqual({
      deploy_target: ["staging please"],
    });
    expect(answersFromText(pending, "1").note).toBeUndefined();
  });

  it("says so when a typed reply only answers the first of several", () => {
    const result = answersFromText(
      { ...pending, questions: [QUESTION, { ...QUESTION, id: "second" }] },
      "1",
    );

    expect(result.answers).toEqual({ deploy_target: ["dev"] });
    expect(result.note).toContain("first question only");
  });

  it("resolves a button click by position and rejects a stale one", () => {
    expect(
      answersFromChoice(pending, {
        answerKey: "abc12345",
        questionIndex: 0,
        optionIndex: 1,
      }),
    ).toEqual({ deploy_target: ["prod"] });
    expect(
      answersFromChoice(pending, {
        answerKey: "abc12345",
        questionIndex: 3,
        optionIndex: 0,
      }),
    ).toBeUndefined();
  });

  it("expires a prompt nobody answered in time and keeps the rest open", async () => {
    stubMutations();
    const stale: AsyncToolResultRecord = questionRow("async_tool_old", {
      ...pending,
      answerBy: new Date(Date.now() - 1000).toISOString(),
    });
    const fresh = questionRow("async_tool_new", pending);
    runtime.query = mock(async () => [stale, fresh]) as never;

    const open = await listOpenQuestions("acct:a:agent:b:conv");

    expect(open.map((row) => row.resultId)).toEqual(["async_tool_new"]);
    const expired = mutations.find(
      (m) =>
        m.name === "updateAsyncToolResult" &&
        m.args.resultId === "async_tool_old",
    );
    expect(expired?.args).toMatchObject({
      status: "failed",
      error: NO_ANSWER_ERROR,
    });
  });

  it("renders the free-text hint only when the question allows it", () => {
    expect(formatQuestionsText([QUESTION])).not.toContain("your own answer");
    expect(
      formatQuestionsText([{ ...QUESTION, allowFreeText: true }]),
    ).toContain("Or reply with your own answer.");
  });
});

function stubMutations(): void {
  runtime.mutate = mock(async (name: string, args: Record<string, unknown>) => {
    mutations.push({ name: name, args: args });

    return name === "createAsyncToolResult" ? true : null;
  }) as never;
}

function channelContext(
  overrides: Partial<ChannelToolContext["actions"]> & {
    transformText?: ChannelToolContext["transformText"];
  } = {},
): ChannelToolContext {
  const { transformText, ...actions } = overrides;

  return {
    channelName: "telegram",
    transformText: transformText ?? (async (text) => text),
    actions: {
      sendText: async () => {},
      sendTyping: async () => {},
      reactToMessage: async () => {},
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
    conversationKey: "acct:a:agent:b:conv",
    toolName: "ask_questions",
    toolCallId: "call-1",
    input: input,
    status: "processing",
    createdAt: now,
    updatedAt: now,
    expiresAt: 0,
  };
}

function toolExecute(
  tools: ToolSet,
): (input: AskQuestionsInput) => Promise<AskQuestionsOutput> {
  const execute = tools.ask_questions!.execute as ToolExecuteFunction<
    AskQuestionsInput,
    AskQuestionsOutput,
    Record<string, unknown>
  >;

  return (input) =>
    Promise.resolve(
      execute(input, {
        toolCallId: "call-1",
        messages: [],
        context: {},
      }) as Promise<AskQuestionsOutput>,
    );
}
