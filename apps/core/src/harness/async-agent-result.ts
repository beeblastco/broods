/** Async agent status persistence backed by Convex transactions. */

import { runtime } from "../shared/convex/runtime.ts";
import type { ToolApprovalSummary } from "./harness.ts";
export type AsyncAgentStatus =
  | "processing"
  | "awaiting_approval"
  | "completed"
  | "failed";
export interface AsyncAgentResultRecord {
  eventId: string;
  conversationKey: string;
  status: AsyncAgentStatus;
  createdAt: string;
  updatedAt: string;
  response?: unknown;
  error?: string;
  approvals?: ToolApprovalSummary[];
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
  return runtime.query("getAsyncAgentResult", { eventId });
}
export async function markAsyncAgentResultCompleted(options: {
  eventId: string;
  response: unknown;
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
