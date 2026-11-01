/**
 * ask_questions: model-facing tool that puts one to three structured
 * questions to the person behind the conversation without holding the run.
 * It leaves the same detached async-tool row a background bash job does and
 * posts the prompt where the turn came from; ../questions.ts matches the
 * answer and handler.ts resumes the conversation.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ChannelQuestion } from "../../shared/channels.ts";
import { logInfo } from "../../shared/log.ts";
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

// The SDK validates every call against this before `execute` runs and hands a
// failure back to the model to retry. Strict objects, because
// `pendingQuestionSummaryValidator` refuses an unknown key on the outcome
// write just as hard as a missing one.
const askQuestionsInput = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        id: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .describe(
            "snake_case key the answer comes back under, unique within the call.",
          ),
        header: z
          .string()
          .min(1)
          .max(MAX_HEADER_LENGTH)
          .describe(`Short label, at most ${MAX_HEADER_LENGTH} characters.`),
        question: z
          .string()
          .min(1)
          .describe("One sentence, in the language of the conversation."),
        options: z
          .array(
            z.strictObject({
              label: z.string().min(1),
              description: z.string().optional(),
            }),
          )
          .min(MIN_OPTIONS)
          .max(MAX_OPTIONS),
      }),
    )
    .min(1)
    .max(MAX_QUESTIONS),
  blocking: z
    .boolean()
    .optional()
    .describe(
      "true to stop the turn until the answer arrives; false (default) to keep working.",
    ),
  timeoutSeconds: z
    .int()
    .min(MIN_ANSWER_TIMEOUT_SECONDS)
    .max(MAX_ANSWER_TIMEOUT_SECONDS)
    .optional()
    .describe(
      `Seconds to wait before the prompt counts as no_answer. Default ${DEFAULT_ANSWER_TIMEOUT_SECONDS}.`,
    ),
});

export type AskQuestionsInput = z.infer<typeof askQuestionsInput>;

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
      inputSchema: askQuestionsInput,
      execute: async function (input, options): Promise<AskQuestionsOutput> {
        const invalid = validateQuestions(input.questions);
        if (invalid) {
          return toolError(`Error: ${invalid}`);
        }
        const blocking = input.blocking === true;
        const resultId = `async_tool_${crypto.randomUUID()}`;
        const answerBy = new Date(
          Date.now() +
            (input.timeoutSeconds ?? DEFAULT_ANSWER_TIMEOUT_SECONDS) * 1000,
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

// The input schema holds every shape and count rule; id uniqueness is the one
// it cannot say.
function validateQuestions(questions: ChannelQuestion[]): string | null {
  const ids = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.id)) {
      return `question id "${question.id}" is used twice`;
    }
    ids.add(question.id);
  }

  return null;
}
