import type {
  Handback,
  HandbackMove,
  SweptHandback,
} from "@broods/convex/model/subagentResults";
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
export type AsyncAgentOutcome =
  | { status: "completed"; response: JSONValue }
  | { status: "failed"; error: string }
  | { status: "awaiting_approval"; approvals: ToolApprovalSummary[] }
  | { status: "awaiting_input"; questions: PendingQuestionSummary[] };
// Stored so a late result still reaches the parent after a restart.
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
export function listOwedAsyncAgentResults(options: {
  handback: SweptHandback;
  status: AsyncAgentStatus;
  updatedAfter: string;
  updatedBefore: string;
  cursor: string | null;
}): Promise<{
  page: AsyncAgentResultRecord[];
  cursor: string;
  isDone: boolean;
}> {
  return runtime.query("listOwedAsyncAgentResults", options);
}
/**
 * True when a queued resume will deliver the result: the caller must not hand it over itself.
 * A failed write is only logged: the row holds the result, and the recovery sweep delivers it.
 */
export async function markAsyncAgentHandback(
  eventId: string,
  handback: HandbackMove,
): Promise<boolean> {
  try {
    return await runtime.mutate("markAsyncAgentHandback", {
      eventId: eventId,
      handback: handback,
    });
  } catch (error) {
    logError("Failed to record a subagent result's hand-back", {
      eventId: eventId,
      handback: handback,
      error: toErrorMessage(error),
    });

    return false;
  }
}
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
