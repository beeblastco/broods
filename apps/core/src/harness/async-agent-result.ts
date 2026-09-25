/** Async agent status persistence backed by Convex transactions. */

import type { JSONValue } from "ai";
import { runtime } from "../shared/convex/runtime.ts";
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
export interface AsyncAgentResultRecord {
  accountId: string;
  eventId: string;
  conversationKey: string;
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
}): Promise<boolean> {
  return runtime.mutate("createAsyncAgentResult", options);
}
export function getAsyncAgentResult(
  eventId: string,
): Promise<AsyncAgentResultRecord | null> {
  return runtime.query("getAsyncAgentResult", { eventId: eventId });
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
