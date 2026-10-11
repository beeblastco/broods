/** Async agent status persistence backed by Convex transactions. */

import type { JSONValue } from "ai";
import { runtime } from "../shared/convex/runtime.ts";
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
 * A subagent task as its parent sees it, and where the parent's conversation
 * answers, so a late result reaches the parent after a restart too.
 */
export interface SubagentTaskRecord {
  taskId: string;
  agentId: string;
  description?: string;
  // The child's public key, the one run_subagent returned.
  conversationKey: string;
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
/** Subagent results no parent has seen yet, written in the window; the recovery sweep reads them. */
export function listUnobservedAsyncAgentResults(window: {
  updatedAfter: string;
  updatedBefore: string;
}): Promise<AsyncAgentResultRecord[]> {
  return runtime.query("listUnobservedAsyncAgentResults", window);
}
/**
 * Records whether a subagent's parent has its result: false when the parent
 * stops waiting on it, true when the parent reads it or is never told.
 */
export async function observeAsyncAgentResult(
  eventId: string,
  observed: boolean,
): Promise<void> {
  await runtime.mutate("observeAsyncAgentResult", {
    eventId: eventId,
    observed: observed,
  });
}
/** Records a run's outcome on its polling row, outside any envelope settle. */
export async function recordAsyncAgentResult(
  eventId: string,
  outcome: AsyncAgentOutcome,
): Promise<void> {
  await runtime.mutate("updateAsyncAgentResult", {
    eventId: eventId,
    ...outcome,
  });
}
