/** Async agent status persistence backed by Convex transactions. */

import type { Handback } from "@broods/convex/model/subagentResults";
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
  // its result; true once it has. Written by the release before `handback`;
  // read through `isHandbackOwed` for one release.
  observed?: boolean;
  // Where a finished subagent result stands with its parent: `pending` until
  // the parent's run stores it, `detached` once that run gave up and the
  // recovery sweep owns it, `stored` once the parent has it.
  handback?: Handback;
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
 * Whether a finished subagent result is still owed to its parent: its
 * hand-back is not `stored`. A row the release before `handback` wrote is
 * owed only once that release detached it (`observed: false`).
 */
export function isHandbackOwed(record: AsyncAgentResultRecord): boolean {
  return record.handback === undefined
    ? record.observed === false
    : record.handback !== "stored";
}
/**
 * One page of subagent results in `status` whose hand-back is `handback`,
 * written in the window, from `cursor`; without `handback`, the rows the
 * release before it detached. The recovery sweep walks every page.
 */
export function listUnobservedAsyncAgentResults(options: {
  handback?: Exclude<Handback, "stored">;
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
 * Moves a subagent result's hand-back: `detached` when this run gives up
 * delivering it, `stored` when the parent reads it or is never told. A
 * stored row stays stored. The row already holds the result, so a failed
 * write is only logged: a pending row reaches the recovery sweep later.
 */
export async function markAsyncAgentHandback(
  eventId: string,
  handback: Exclude<Handback, "pending">,
): Promise<void> {
  try {
    await runtime.mutate("markAsyncAgentHandback", {
      eventId: eventId,
      handback: handback,
    });
  } catch (error) {
    logError("Failed to record a subagent result's hand-back", {
      eventId: eventId,
      handback: handback,
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
  guard: { onlyWhileProcessing?: boolean; handback?: "detached" } = {},
): Promise<void> {
  await runtime.mutate("updateAsyncAgentResult", {
    eventId: eventId,
    ...outcome,
    ...guard,
  });
}
