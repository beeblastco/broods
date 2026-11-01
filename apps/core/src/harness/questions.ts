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

export interface OpenQuestion {
  record: AsyncToolResultRecord;
  pending: PendingQuestionInput;
}

export interface PendingQuestionInput {
  questions: ChannelQuestion[];
  blocking: boolean;
  answerBy: string;
}

export interface PendingQuestionSummary {
  statusId: string;
  questions: ChannelQuestion[];
  answerBy: string;
}

export type QuestionAnswers = Record<string, string[]>;

export interface QuestionAnswerResult {
  status: "answered";
  answers: QuestionAnswers;
  answeredBy?: ChannelIdentity;
  note?: string;
}

export interface RunOpenWork {
  waitingOn?: TaskWaitingOn;
  questions: ChannelQuestion[];
}

export interface RunOpenWorkSources {
  conversationKey: string;
  awaitingApproval: boolean;
  detachedResultIds: string[];
  questionSummaries: PendingQuestionSummary[];
  pendingWork?: () => TaskWaitingOn | undefined;
}

export function answersFromChoice(
  pending: PendingQuestionInput,
  choice: ChannelQuestionAnswer,
): QuestionAnswers | undefined {
  const question = pending.questions[choice.questionIndex];
  const option = question?.options[choice.optionIndex];
  if (!question || !option) return undefined;

  return { [question.id]: [option.label] };
}

// Any text answers the first question, so a reply never slips past it as a new turn.
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
  // Rows, not summaries: an answer can settle one before the run ends. An unread row counts.
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
