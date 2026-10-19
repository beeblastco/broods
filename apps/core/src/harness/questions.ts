/**
 * ask_questions state shared by the tool, the answer intake and the handler.
 * The tool leaves an open async-tool row; a reply, a button click or the
 * direct API settles it; handler.ts resumes the conversation from there.
 * Also reads what a finished run still waits on, questions first among the
 * rows it left open, for its root span.
 */

import type { JSONValue } from "ai";
import type { TaskWaitingOn } from "../../../../packages/broods/src/observability-contracts.ts";
import type {
  ChannelIdentity,
  ChannelQuestion,
  ChannelQuestionAnswer,
} from "../shared/channels.ts";
import { runtime } from "../shared/convex/runtime.ts";
import { logWarn } from "../shared/log.ts";
import {
  getAsyncToolResult,
  markAsyncToolResultFailed,
  settleAsyncToolResultFromCallback,
  type AsyncToolResultRecord,
} from "./async-tool-result.ts";

export const ASK_QUESTIONS_TOOL_NAME = "ask_questions";
export const DEFAULT_ANSWER_TIMEOUT_SECONDS = 24 * 60 * 60;
export const MAX_ANSWER_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
export const MAX_OPTIONS = 4;
export const MAX_QUESTIONS = 3;
export const MIN_ANSWER_TIMEOUT_SECONDS = 30;
export const MIN_OPTIONS = 2;
export const NO_ANSWER_ERROR = "no_answer";

/** An open prompt row with its parsed input. */
export interface OpenQuestion {
  record: AsyncToolResultRecord;
  pending: PendingQuestionInput;
}

/** The row's `input`. `answerBy` is when the prompt stops accepting answers. */
export interface PendingQuestionInput {
  questions: ChannelQuestion[];
  blocking: boolean;
  answerBy: string;
}

/** An open prompt as reported while a run is awaiting_input. */
export interface PendingQuestionSummary {
  statusId: string;
  questions: ChannelQuestion[];
  answerBy: string;
}

/** Chosen labels (or free text) keyed by question id. */
export type QuestionAnswers = Record<string, string[]>;

/** The tool result injected back into the conversation. */
export interface QuestionAnswerResult {
  status: "answered";
  answers: QuestionAnswers;
  answeredBy?: ChannelIdentity;
  note?: string;
}

/** What a finished run still waits on; `questions` is what the person was asked, for the trace's wait row. */
export interface RunOpenWork {
  waitingOn?: TaskWaitingOn;
  questions: ChannelQuestion[];
}

/** What one run left open, as `openWorkAfterRun` reads it. */
export interface RunOpenWorkSources {
  conversationKey: string;
  /** A tool approval is still waiting on the person. */
  awaitingApproval: boolean;
  /** The async-tool rows the run detached, blocking questions among them. */
  detachedResultIds: string[];
  questionSummaries: PendingQuestionSummary[];
  /** In-process work the handler still waits on once the pass ends. */
  pendingWork?: () => TaskWaitingOn | undefined;
}

/** The label a button click stands for; undefined when the click is stale. */
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
 * A typed reply against the first question: an option number or label picks
 * that option, and anything else is the person's own answer. Every question
 * takes one, so a reply never slips past an open question as a new turn. A
 * reply with no text, such as a lone attachment, is not an answer.
 */
export function answersFromText(
  pending: PendingQuestionInput,
  text: string,
): QuestionAnswerResult | undefined {
  const question = pending.questions[0];
  const trimmed = text.trim();
  if (!question || !trimmed) return undefined;
  const byNumber = /^\d+$/.test(trimmed)
    ? question.options[Number(trimmed) - 1]
    : undefined;
  const byLabel = question.options.find(
    (option): boolean => option.label.toLowerCase() === trimmed.toLowerCase(),
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
    .map((question): string => {
      const lines = [question.question];
      question.options.forEach((option, index): void => {
        lines.push(
          `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`,
        );
      });
      lines.push("Or reply with your own answer.");

      return lines.join("\n");
    })
    .join("\n\n");
}

/** Open prompts on a conversation, oldest first. Expired ones settle on the way out. */
export async function listOpenQuestions(
  conversationKey: string,
): Promise<OpenQuestion[]> {
  const rows = await runtime.query("listPendingAsyncToolResults", {
    conversationKey: conversationKey,
    toolName: ASK_QUESTIONS_TOOL_NAME,
  });

  return rows
    .map((row): OpenQuestion | undefined => openQuestion(row, conversationKey))
    .filter((open): open is OpenQuestion => open !== undefined);
}

/**
 * The row as an open prompt, or undefined when it is not one this
 * conversation may answer. A prompt past `answerBy` is settled as no_answer.
 */
export function openQuestion(
  record: AsyncToolResultRecord | null,
  conversationKey: string,
): OpenQuestion | undefined {
  if (
    !record ||
    record.conversationKey !== conversationKey ||
    record.toolName !== ASK_QUESTIONS_TOOL_NAME ||
    record.status !== "processing"
  ) {
    return undefined;
  }
  const pending = record.input as PendingQuestionInput;
  if (Date.parse(pending.answerBy) < Date.now()) {
    void markAsyncToolResultFailed({
      resultId: record.resultId,
      error: NO_ANSWER_ERROR,
    }).catch((error: unknown): void => {
      logWarn("Failed to expire an unanswered question", {
        resultId: record.resultId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return undefined;
  }

  return { record: record, pending: pending };
}

/**
 * What a run that ended cleanly still waits on, the person first: an approval
 * or an open question needs them, while subagents, async tools and background
 * jobs settle by themselves. Empty when nothing is left open. Read once by the
 * run finalizer for the root span's closing state, never for a failed run.
 */
export async function openWorkAfterRun(
  run: RunOpenWorkSources,
): Promise<RunOpenWork> {
  if (run.awaitingApproval) {
    return { waitingOn: "approval", questions: [] };
  }
  const rows = await Promise.all(
    run.detachedResultIds.map((resultId) =>
      getAsyncToolResult(resultId).catch(() => null),
    ),
  );
  const open = rows.filter((row) => row?.status === "processing");
  const questions = open.flatMap(
    (row): ChannelQuestion[] =>
      openQuestion(row, run.conversationKey)?.pending.questions ?? [],
  );
  // The rows, not questionSummaries: an answer can settle one before the run
  // ends. A blocking question whose row could not be read still counts.
  const unread = run.questionSummaries
    .filter(
      (summary) =>
        rows[run.detachedResultIds.indexOf(summary.statusId)] === null,
    )
    .flatMap((summary) => summary.questions);
  if (questions.length > 0 || unread.length > 0) {
    return { waitingOn: "question", questions: [...questions, ...unread] };
  }
  const pending = run.pendingWork?.();
  if (pending) return { waitingOn: pending, questions: [] };

  return {
    ...(open.length > 0 ? { waitingOn: "tool" } : {}),
    questions: [],
  };
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
