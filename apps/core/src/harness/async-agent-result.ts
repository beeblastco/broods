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
export async function markAsyncAgentResultCompleted(options: {
  eventId: string;
  response: JSONValue;
}): Promise<void> {
  await runtime.mutate("updateAsyncAgentResult", {
    eventId: options.eventId,
    status: "completed",
    response: options.response,
  });
}
export async function markAsyncAgentResultFailed(options: {
  eventId: string;
  error: string;
}): Promise<void> {
  await runtime.mutate("updateAsyncAgentResult", {
    eventId: options.eventId,
    status: "failed",
    error: options.error,
  });
}
export async function markAsyncAgentResultAwaitingApproval(options: {
  eventId: string;
  approvals: ToolApprovalSummary[];
}): Promise<void> {
  await runtime.mutate("updateAsyncAgentResult", {
    eventId: options.eventId,
    status: "awaiting_approval",
    approvals: options.approvals,
  });
}
export async function markAsyncAgentResultAwaitingInput(options: {
  eventId: string;
  questions: PendingQuestionSummary[];
}): Promise<void> {
  await runtime.mutate("updateAsyncAgentResult", {
    eventId: options.eventId,
    status: "awaiting_input",
    questions: options.questions,
  });
}
