/**
 * ask_questions — model-facing tool to put one to three structured questions
 * to the person behind the conversation, without holding the run open.
 *
 * It writes an open async-tool row (the same detached shape a background bash
 * job uses), posts the prompt where the turn came from, and returns at once.
 * With `blocking: false` the model keeps working and the answer is injected
 * when it arrives; with `blocking: true` the harness ends the turn after this
 * step and the answer resumes the conversation. Matching and settling live in
 * ../questions.ts; the resume path is handler.ts's async-tool continuation.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { ChannelQuestion } from "../../shared/channels.ts";
import { logInfo } from "../../shared/log.ts";
import {
  createPendingAsyncToolResult,
  markAsyncToolResultFailed,
  sealDetachedAsyncToolGroup,
  type AsyncToolDelivery,
} from "../async-tool-result.ts";
import {
  ASK_QUESTIONS_TOOL_NAME,
  DEFAULT_ANSWER_TIMEOUT_SECONDS,
  MAX_ANSWER_TIMEOUT_SECONDS,
  MAX_HEADER_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_ANSWER_TIMEOUT_SECONDS,
  MIN_OPTIONS,
  formatQuestionsText,
  newAnswerKey,
  type PendingQuestionInput,
} from "../questions.ts";
import type { ChannelToolContext } from "./channel.tool.ts";
import { toolError } from "./utils.ts";

const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface AskQuestionsInput {
  questions: ChannelQuestion[];
  blocking?: boolean;
  timeoutSeconds?: number;
}

/** What the model gets back right away; the answer comes later as a result. */
export interface AskQuestionsOutput {
  statusId: string;
  status: "asked";
  blocking: boolean;
  answerBy: string;
  note: string;
}

export interface AskQuestionsContext {
  conversationKey: string;
  // The turn that asked; the row's parent event is derived from it.
  eventId: string;
  // Where the answer should resume the conversation. Absent for a plain direct
  // API turn, which polls status instead.
  delivery?: AsyncToolDelivery;
  // The channel the turn came from, when there is one to post the prompt to.
  channel?: ChannelToolContext;
}

export default function askQuestionsTool(
  context: AskQuestionsContext,
): ToolSet {
  return {
    [ASK_QUESTIONS_TOOL_NAME]: tool({
      description: `Ask the person you are working for one to ${MAX_QUESTIONS} structured questions and get the answers back later, without holding the turn open.

Use it for decisions that are theirs to make, not for confirmation you can infer from the request, the code, or a sensible default. Each question offers ${MIN_OPTIONS} to ${MAX_OPTIONS} options; set allowFreeText when a typed answer is also fine.

- blocking: false (default): the tool returns a statusId and you keep working on whatever does not depend on the answer. The answer is delivered into this conversation automatically when it arrives (or "no_answer" if nobody answers in time).
- blocking: true: use it only when nothing useful can happen before the answer. End your turn right after calling it, with no further tool calls; the answer will resume this conversation.

Never ask the same question twice, and never poll async_status for it unless the user asks.`,
      inputSchema: jsonSchema<AskQuestionsInput>({
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: MAX_QUESTIONS,
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "snake_case key the answer comes back under, unique within the call.",
                },
                header: {
                  type: "string",
                  maxLength: MAX_HEADER_LENGTH,
                  description: `Short label for the question, at most ${MAX_HEADER_LENGTH} characters.`,
                },
                question: {
                  type: "string",
                  description:
                    "The question itself, one sentence, in the language of the conversation.",
                },
                options: {
                  type: "array",
                  minItems: MIN_OPTIONS,
                  maxItems: MAX_OPTIONS,
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["label"],
                    additionalProperties: false,
                  },
                },
                multiSelect: {
                  type: "boolean",
                  description: "Allow more than one option to be chosen.",
                },
                allowFreeText: {
                  type: "boolean",
                  description:
                    "Accept a typed answer that is not one of the options.",
                },
              },
              required: ["id", "header", "question", "options"],
              additionalProperties: false,
            },
          },
          blocking: {
            type: "boolean",
            description:
              "true to stop the turn until the answer arrives; false (default) to keep working.",
          },
          timeoutSeconds: {
            type: "integer",
            minimum: MIN_ANSWER_TIMEOUT_SECONDS,
            maximum: MAX_ANSWER_TIMEOUT_SECONDS,
            description: `How long to wait for an answer before it counts as no_answer. Default ${DEFAULT_ANSWER_TIMEOUT_SECONDS}.`,
          },
        },
        required: ["questions"],
        additionalProperties: false,
      }),
      execute: async function (input, options): Promise<AskQuestionsOutput> {
        const invalid = validateQuestions(input.questions);
        if (invalid) {
          return toolError(`Error: ${invalid}`);
        }
        const blocking = input.blocking === true;
        const timeoutSeconds = clampTimeout(input.timeoutSeconds);
        const resultId = `async_tool_${crypto.randomUUID()}`;
        const answerBy = new Date(
          Date.now() + timeoutSeconds * 1000,
        ).toISOString();
        const pending: PendingQuestionInput = {
          kind: "question",
          answerKey: newAnswerKey(),
          questions: input.questions,
          blocking: blocking,
          answerBy: answerBy,
        };

        // Own parent event, sealed at once: like a background bash job this is
        // a group of exactly one, so the answer can resume as soon as it lands.
        const parentEventId = `${context.eventId}:async-question:${resultId}`;
        await createPendingAsyncToolResult({
          resultId: resultId,
          parentEventId: parentEventId,
          conversationKey: context.conversationKey,
          toolName: ASK_QUESTIONS_TOOL_NAME,
          toolCallId: options.toolCallId,
          input: pending,
          delivery: context.delivery ?? { kind: "async" },
        });
        await sealDetachedAsyncToolGroup(parentEventId);

        if (context.channel) {
          const posted = await postToChannel(context.channel, pending);
          if (posted !== null) {
            await markAsyncToolResultFailed({
              resultId: resultId,
              error: posted,
            }).catch(() => {});

            return toolError(`Error: ${posted}`);
          }
        }

        logInfo("ask_questions posted", {
          conversationKey: context.conversationKey,
          resultId: resultId,
          questionCount: input.questions.length,
          blocking: blocking,
          channel: context.channel?.channelName,
        });

        return {
          statusId: resultId,
          status: "asked",
          blocking: blocking,
          answerBy: answerBy,
          note: blocking
            ? "End your turn now with no further tool calls. The answer will resume this conversation."
            : "Keep working. The answer is delivered into this conversation automatically when it arrives.",
        };
      },
    }),
  };
}

// Returns the failure reason, or null once the prompt is out.
async function postToChannel(
  channel: ChannelToolContext,
  pending: PendingQuestionInput,
): Promise<string | null> {
  const text = await channel.transformText(
    formatQuestionsText(pending.questions),
  );
  if (text === null) {
    return "question blocked by the outbound message hook";
  }
  const prompt = {
    answerKey: pending.answerKey,
    questions: pending.questions,
    text: text,
  };
  if (channel.actions.sendQuestions) {
    await channel.actions.sendQuestions(prompt);
  } else {
    await channel.actions.sendText(text);
  }

  return null;
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_ANSWER_TIMEOUT_SECONDS;
  }

  return Math.min(
    MAX_ANSWER_TIMEOUT_SECONDS,
    Math.max(MIN_ANSWER_TIMEOUT_SECONDS, Math.floor(value)),
  );
}

function validateQuestions(questions: ChannelQuestion[]): string | null {
  if (questions.length === 0 || questions.length > MAX_QUESTIONS) {
    return `ask_questions takes 1 to ${MAX_QUESTIONS} questions`;
  }
  const ids = new Set<string>();
  for (const question of questions) {
    if (!QUESTION_ID_PATTERN.test(question.id)) {
      return `question id "${question.id}" must be snake_case`;
    }
    if (ids.has(question.id)) {
      return `question id "${question.id}" is used twice`;
    }
    ids.add(question.id);
    if (question.header.trim().length === 0) {
      return `question "${question.id}" needs a header`;
    }
    if (question.header.length > MAX_HEADER_LENGTH) {
      return `question "${question.id}" header is longer than ${MAX_HEADER_LENGTH} characters`;
    }
    if (question.question.trim().length === 0) {
      return `question "${question.id}" is empty`;
    }
    if (
      question.options.length < MIN_OPTIONS ||
      question.options.length > MAX_OPTIONS
    ) {
      return `question "${question.id}" needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options`;
    }
    if (question.options.some((option) => option.label.trim().length === 0)) {
      return `question "${question.id}" has an option with no label`;
    }
  }

  return null;
}
