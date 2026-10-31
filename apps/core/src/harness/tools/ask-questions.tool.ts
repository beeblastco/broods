/**
 * ask_questions: model-facing tool that puts one to three structured
 * questions to the person behind the conversation without holding the run.
 * It leaves the same detached async-tool row a background bash job does and
 * posts the prompt where the turn came from; ../questions.ts matches the
 * answer and handler.ts resumes the conversation.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import type { ChannelQuestion } from "../../shared/channels.ts";
import { logInfo } from "../../shared/log.ts";
import { isPlainObject } from "../../shared/object.ts";
import {
  createDetachedAsyncToolResult,
  markAsyncToolResultFailed,
  type AsyncToolDelivery,
} from "../async-tool-result.ts";
import {
  ASK_QUESTIONS_TOOL_NAME,
  DEFAULT_ANSWER_TIMEOUT_SECONDS,
  MAX_ANSWER_TIMEOUT_SECONDS,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_ANSWER_TIMEOUT_SECONDS,
  MIN_OPTIONS,
  formatQuestionsText,
  type PendingQuestionInput,
  type PendingQuestionSummary,
} from "../questions.ts";
import type { ChannelToolContext } from "./channel.tool.ts";
import { toolError } from "./utils.ts";

const MAX_HEADER_LENGTH = 12;
// The exact shapes `pendingQuestionSummaryValidator` stores.
const QUESTION_KEYS = new Set(["id", "header", "question", "options"]);
const OPTION_KEYS = new Set(["label", "description"]);

export interface AskQuestionsContext {
  conversationKey: string;
  eventId: string;
  delivery?: AsyncToolDelivery;
  channel?: ChannelToolContext;
  // Tells the harness to end the turn after this step.
  onBlockingQuestion?: (question: PendingQuestionSummary) => void;
  // Tells the harness a question is open, blocking or not.
  onDetachedResult?: (resultId: string) => void;
}

export interface AskQuestionsInput {
  questions: ChannelQuestion[];
  blocking?: boolean;
  timeoutSeconds?: number;
}

export interface AskQuestionsOutput {
  statusId: string;
  blocking: boolean;
  answerBy: string;
}

export default function askQuestionsTool(
  context: AskQuestionsContext,
): ToolSet {
  return {
    [ASK_QUESTIONS_TOOL_NAME]: tool({
      description: `Ask the person you are working for up to ${MAX_QUESTIONS} structured questions, each with ${MIN_OPTIONS} to ${MAX_OPTIONS} options, for decisions that are theirs to make. Do not use it for confirmation you can infer from the request, the code, or a sensible default. Every question already accepts the person's own typed answer, so never add an option like "Other" or "Type my own"; picking it would end the question before they could type.

The tool returns a statusId at once and the answer is delivered into this conversation automatically when it arrives ("no_answer" if nobody answers in time). With blocking false (default) keep working on what does not depend on the answer. With blocking true, end your turn right after this call with no further tool calls; the answer will resume the conversation. Never ask the same question twice or poll async_status for it.`,
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
                  pattern: "^[a-z][a-z0-9_]*$",
                  description:
                    "snake_case key the answer comes back under, unique within the call.",
                },
                header: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_HEADER_LENGTH,
                  description: `Short label, at most ${MAX_HEADER_LENGTH} characters.`,
                },
                question: {
                  type: "string",
                  minLength: 1,
                  description:
                    "One sentence, in the language of the conversation.",
                },
                options: {
                  type: "array",
                  minItems: MIN_OPTIONS,
                  maxItems: MAX_OPTIONS,
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", minLength: 1 },
                      description: { type: "string" },
                    },
                    required: ["label"],
                    additionalProperties: false,
                  },
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
            description: `Seconds to wait before the prompt counts as no_answer. Default ${DEFAULT_ANSWER_TIMEOUT_SECONDS}.`,
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
        const resultId = `async_tool_${crypto.randomUUID()}`;
        const answerBy = new Date(
          Date.now() + clampTimeout(input.timeoutSeconds) * 1000,
        ).toISOString();
        const pending: PendingQuestionInput = {
          questions: input.questions,
          blocking: blocking,
          answerBy: answerBy,
        };

        await createDetachedAsyncToolResult({
          eventId: context.eventId,
          tag: "async-question",
          resultId: resultId,
          conversationKey: context.conversationKey,
          toolName: ASK_QUESTIONS_TOOL_NAME,
          toolCallId: options.toolCallId,
          input: pending,
          delivery: context.delivery ?? { kind: "async" },
        });
        context.onDetachedResult?.(resultId);

        if (context.channel) {
          const failure = await postToChannel(
            context.channel,
            resultId,
            input.questions,
          );
          if (failure !== null) {
            await markAsyncToolResultFailed({
              resultId: resultId,
              error: failure,
            }).catch((): void => {});

            return toolError(`Error: ${failure}`);
          }
        }
        if (blocking) {
          context.onBlockingQuestion?.({
            statusId: resultId,
            questions: input.questions,
            answerBy: answerBy,
          });
        }

        logInfo("ask_questions posted", {
          conversationKey: context.conversationKey,
          resultId: resultId,
          questionCount: input.questions.length,
          blocking: blocking,
          channel: context.channel?.channelName,
        });

        return { statusId: resultId, blocking: blocking, answerBy: answerBy };
      },
    }),
  };
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

// The failure reason, or null once the prompt is out.
async function postToChannel(
  channel: ChannelToolContext,
  statusId: string,
  questions: ChannelQuestion[],
): Promise<string | null> {
  const text = await channel.transformText(formatQuestionsText(questions));
  if (text === null) {
    return "question blocked by the outbound message hook";
  }
  if (channel.actions.sendQuestions) {
    await channel.actions.sendQuestions({
      statusId: statusId,
      questions: questions,
      text: text,
    });
  } else {
    await channel.actions.sendText(text);
  }

  return null;
}

// The JSON schema only steers the model: `jsonSchema` carries no runtime
// validator, so every rule has to hold here, before a row is stored. A shape
// the model got wrong must come back as a tool error it can retry, not fail
// `pendingQuestionSummaryValidator` on the Convex write after the question
// already posted.
function validateQuestions(questions: ChannelQuestion[]): string | null {
  if (
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.length > MAX_QUESTIONS
  ) {
    return `ask_questions takes 1 to ${MAX_QUESTIONS} questions`;
  }
  const ids = new Set<string>();
  for (const question of questions) {
    const malformed = malformedQuestion(question);
    if (malformed) {
      return malformed;
    }
    if (ids.has(question.id)) {
      return `question id "${question.id}" is used twice`;
    }
    ids.add(question.id);
    if (
      question.options.length < MIN_OPTIONS ||
      question.options.length > MAX_OPTIONS
    ) {
      return `question "${question.id}" needs ${MIN_OPTIONS} to ${MAX_OPTIONS} options`;
    }
  }

  return null;
}

// Shape check on the model's JSON, matching `pendingQuestionSummaryValidator`
// exactly: that validator rejects an unknown key or a missing field just as
// hard, so anything it would refuse must be refused here first.
function malformedQuestion(candidate: ChannelQuestion): string | null {
  const question: unknown = candidate;
  if (!isPlainObject(question)) {
    return "each question must be an object";
  }
  const extra = Object.keys(question).find((key) => !QUESTION_KEYS.has(key));
  if (extra !== undefined) {
    return `a question carries an unknown key "${extra}"`;
  }
  if (
    typeof question.id !== "string" ||
    typeof question.header !== "string" ||
    typeof question.question !== "string"
  ) {
    return "a question is missing its id, header or question text";
  }
  if (!Array.isArray(question.options)) {
    return `question "${question.id}" is missing its options`;
  }
  for (const option of question.options as unknown[]) {
    if (!isPlainObject(option)) {
      return `question "${question.id}" has a malformed option`;
    }
    const extraOption = Object.keys(option).find(
      (key) => !OPTION_KEYS.has(key),
    );
    if (extraOption !== undefined) {
      return `an option on "${question.id}" carries an unknown key "${extraOption}"`;
    }
    if (typeof option.label !== "string") {
      return `an option on "${question.id}" is missing its label`;
    }
    if (
      option.description !== undefined &&
      typeof option.description !== "string"
    ) {
      return `an option on "${question.id}" has a non-string description`;
    }
  }

  return null;
}
