/** Async agent status persistence backed by Convex transactions. */

import type { JSONValue } from "ai";
import { runtime } from "../shared/convex/runtime.ts";
import { toErrorMessage } from "../shared/errors.ts";
import { logError } from "../shared/log.ts";
import type { AsyncToolDelivery } from "./async-tool-result.ts";
import type { ToolApprovalSummary } from "./harness.ts";
import type { PendingQuestionSummary } from "./questions.ts";
export type AsyncAgentStatus =
  | "processing"
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "failed";
/** How an async run ended, or what it waits on, as its polling row records it. */
export type AsyncAgentOutcome =
  | { status: "completed"; response: JSONValue }
  | { status: "failed"; error: string }
  | { status: "awaiting_approval"; approvals: ToolApprovalSummary[] }
  | { status: "awaiting_input"; questions: PendingQuestionSummary[] };
/**
 * Where a subagent's parent conversation answers, so a late result reaches the
 * parent after a restart too. The task, the child agent and its key come from
 * the row's own `eventId` and `conversationKey`.
 */
export interface SubagentTaskRecord {
  description?: string;
  parentConversationKey: string;
  parentDelivery?: AsyncToolDelivery;
}
export interface AsyncAgentResultRecord {
  accountId: string;
  eventId: string;
  conversationKey: string;
  subagent?: SubagentTaskRecord;
  // False while the parent stopped waiting on this subagent and has not seen
  // its result; true once it has.
  observed?: boolean;
  status: AsyncAgentStatus;
  createdAt: string;
  updatedAt: string;
  response?: JSONValue;
  error?: string;
  approvals?: ToolApprovalSummary[];
  questions?: PendingQuestionSummary[];
  expiresAt: number;
}
export function createPendingAsyncAgentResult(options: {
  eventId: string;
  conversationKey: string;
  subagent?: SubagentTaskRecord;
}): Promise<boolean> {
  return runtime.mutate("createAsyncAgentResult", options);
}
export function getAsyncAgentResult(
  eventId: string,
): Promise<AsyncAgentResultRecord | null> {
  return runtime.query("getAsyncAgentResult", { eventId: eventId });
}
/**
 * One page of subagent results in `status` no parent has seen yet, written in
 * the window, from `cursor`. The recovery sweep walks every page.
 */
export function listUnobservedAsyncAgentResults(options: {
  status: AsyncAgentStatus;
  updatedAfter: string;
  updatedBefore: string;
  cursor: string | null;
}): Promise<{
  page: AsyncAgentResultRecord[];
  cursor: string;
  isDone: boolean;
}> {
  return runtime.query("listUnobservedAsyncAgentResults", options);
}
/**
 * Records whether a subagent's parent has its result: false when the parent
 * stops waiting on it, true when the parent reads it or is never told. The
 * row already holds the result, so a failed write is only logged.
 */
export async function observeAsyncAgentResult(
  eventId: string,
  observed: boolean,
): Promise<void> {
  try {
    await runtime.mutate("observeAsyncAgentResult", {
      eventId: eventId,
      observed: observed,
    });
  } catch (error) {
    logError("Failed to record whether the parent saw a subagent result", {
      eventId: eventId,
      observed: observed,
      error: toErrorMessage(error),
    });
  }
}
/**
 * Records a run's outcome on its polling row, outside any envelope settle.
 * `onlyWhileProcessing` leaves a row that already has its outcome alone.
 */
export async function recordAsyncAgentResult(
  eventId: string,
  outcome: AsyncAgentOutcome,
  guard: { onlyWhileProcessing?: boolean } = {},
): Promise<void> {
  await runtime.mutate("updateAsyncAgentResult", {
    eventId: eventId,
    ...outcome,
    ...guard,
  });
}
