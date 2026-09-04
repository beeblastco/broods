/**
 * ask_questions state shared by the tool, the answer intake and the handler.
 * The tool leaves an open async-tool row here; a channel reply, a button click
 * or the direct API settles it; handler.ts then resumes the conversation the
 * same way a finished background job does. Tool schema and posting live in
 * tools/ask-questions.tool.ts; per-provider rendering in the channel adapters.
 */

import type { JSONValue } from "ai";
import type {
  ChannelIdentity,
  ChannelQuestion,
  ChannelQuestionAnswer,
} from "../shared/channels.ts";
import { runtime } from "../shared/convex/runtime.ts";
import { logWarn } from "../shared/log.ts";
import {
  markAsyncToolResultFailed,
  settleAsyncToolResultFromCallback,
  type AsyncToolResultRecord,
} from "./async-tool-result.ts";

export const ASK_QUESTIONS_TOOL_NAME = "ask_questions";
export const MAX_QUESTIONS = 3;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 12;
export const DEFAULT_ANSWER_TIMEOUT_SECONDS = 900;
export const MIN_ANSWER_TIMEOUT_SECONDS = 30;
export const MAX_ANSWER_TIMEOUT_SECONDS = 3600;
export const NO_ANSWER_ERROR = "no_answer";
// Fits beside "q:", two indices and separators inside Telegram's 64-byte cap.
const ANSWER_KEY_LENGTH = 8;

/** What the tool stores as the row's `input`, so the intake can match a reply. */
export interface PendingQuestionInput {
  kind: "question";
  answerKey: string;
  questions: ChannelQuestion[];
  blocking: boolean;
  // ISO time after which the prompt is considered unanswered.
  answerBy: string;
}

/** Labels (or free text) chosen per question id. */
export type QuestionAnswers = Record<string, string[]>;

/** The value injected back into the conversation as the tool result. */
export interface QuestionAnswerResult {
  status: "answered";
  answers: QuestionAnswers;
  answeredBy?: Pick<ChannelIdentity, "userId" | "userName">;
  note?: string;
}

/** Public shape of an open prompt, reported while a run is awaiting_input. */
export interface PendingQuestionSummary {
  statusId: string;
  questions: ChannelQuestion[];
  answerBy: string;
}

/** A structured answer from the direct API body. */
export interface DirectQuestionAnswer {
  statusId: string;
  answers: QuestionAnswers;
}

/** The row's `input` when it is an ask_questions prompt, else undefined. */
export function pendingQuestionInput(
  input: unknown,
): PendingQuestionInput | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Partial<PendingQuestionInput>;
  if (
    record.kind !== "question" ||
    typeof record.answerKey !== "string" ||
    !Array.isArray(record.questions) ||
    typeof record.answerBy !== "string"
  ) {
    return undefined;
  }

  return {
    kind: "question",
    answerKey: record.answerKey,
    questions: record.questions,
    blocking: record.blocking === true,
    answerBy: record.answerBy,
  };
}

/**
 * Open prompts on a conversation, oldest first. A prompt past its answerBy is
 * settled as no_answer on the way out, so a late reply reads as a normal
 * message rather than an answer to a question the agent stopped waiting for.
 */
export async function listOpenQuestions(
  conversationKey: string,
): Promise<AsyncToolResultRecord[]> {
  const rows = await runtime.query<AsyncToolResultRecord[]>(
    "listPendingAsyncToolResults",
    { conversationKey: conversationKey, toolName: ASK_QUESTIONS_TOOL_NAME },
  );
  const now = Date.now();
  const open: AsyncToolResultRecord[] = [];
  for (const row of rows) {
    const pending = pendingQuestionInput(row.input);
    if (!pending) continue;
    if (Date.parse(pending.answerBy) < now) {
      await markAsyncToolResultFailed({
        resultId: row.resultId,
        error: NO_ANSWER_ERROR,
      }).catch((error: unknown) => {
        logWarn("Failed to expire an unanswered question", {
          resultId: row.resultId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      continue;
    }
    open.push(row);
  }

  return open;
}

/** Resolves a button click to the label it stands for. */
export function answersFromChoice(
  pending: PendingQuestionInput,
  choice: ChannelQuestionAnswer,
): QuestionAnswers | undefined {
  const question = pending.questions[choice.questionIndex];
  const option = question?.options[choice.optionIndex];
  if (!question || !option) return undefined;

  return { [question.id]: [option.label] };
}

/**
 * Resolves a typed reply against the first question: an option number or
 * label picks that option, anything else is taken as free text. Only the
 * first question is answered this way; buttons carry their own position.
 */
export function answersFromText(
  pending: PendingQuestionInput,
  text: string,
): QuestionAnswerResult {
  const question = pending.questions[0];
  if (!question) {
    return { status: "answered", answers: {} };
  }
  const trimmed = text.trim();
  const byNumber = /^\d+$/.test(trimmed)
    ? question.options[Number(trimmed) - 1]
    : undefined;
  const byLabel = question.options.find(
    (option) => option.label.toLowerCase() === trimmed.toLowerCase(),
  );
  const chosen = byNumber ?? byLabel;

  return {
    status: "answered",
    answers: { [question.id]: [chosen ? chosen.label : trimmed] },
    ...(pending.questions.length > 1
      ? {
          note: "A typed reply answers the first question only; the rest are still open to the user.",
        }
      : {}),
  };
}

/** Numbered plain-text rendering every channel can post. */
export function formatQuestionsText(questions: ChannelQuestion[]): string {
  return questions
    .map((question) => {
      const lines = [question.question];
      question.options.forEach((option, index) => {
        lines.push(
          `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`,
        );
      });
      if (question.allowFreeText) {
        lines.push("Or reply with your own answer.");
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

export function newAnswerKey(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, ANSWER_KEY_LENGTH);
}

/** Settles an open prompt with its answer. Null when it already settled. */
export function settleQuestion(
  record: AsyncToolResultRecord,
  result: QuestionAnswerResult,
): Promise<AsyncToolResultRecord | null> {
  return settleAsyncToolResultFromCallback({
    resultId: record.resultId,
    status: "completed",
    response: result as unknown as JSONValue,
  });
}

/** Public summary for status responses and the blocking stop. */
export function toPendingQuestionSummary(
  statusId: string,
  pending: PendingQuestionInput,
): PendingQuestionSummary {
  return {
    statusId: statusId,
    questions: pending.questions,
    answerBy: pending.answerBy,
  };
}
