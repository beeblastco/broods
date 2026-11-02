import type {
  Handback,
  HandbackMove,
  SweptHandback,
} from "@broods/convex/model/subagentResults";
import type { JSONValue } from "ai";
import { runtime } from "../shared/convex/runtime.ts";
import { toErrorMessage } from "../shared/errors.ts";
import { logError } from "../shared/log.ts";
import type { PrincipalLink } from "../shared/domain/principal.ts";
import type { AsyncToolDelivery } from "./async-tool-result.ts";
import type { ToolApprovalSummary } from "./harness.ts";
import type { PendingQuestionSummary } from "./questions.ts";
import type { RunTrigger } from "./session.ts";
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
  | { status: "awaiting_input"; questions: PendingQuestionSummary[] }
  | { status: "awaiting_input"; question: string; answerBy: number };
// Stored so a late result reaches the parent after a restart, with who the parent run acted as.
export interface SubagentTaskRecord {
  description?: string;
  parentConversationKey: string;
  parentDelivery?: AsyncToolDelivery;
  parentPolicyDelivery?: AsyncToolDelivery;
  parentTrigger?: RunTrigger;
  parentPrincipalChain?: PrincipalLink[];
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
  question?: string;
  // When `question` stops waiting on the parent's reply, until closed.
  answerBy?: number;
  expiresAt: number;
}
/** Closes the message a child waits on its parent with; true for the one call that closed it. */
export function closeSubagentQuestion(
  conversationKey: string,
): Promise<boolean> {
  return runtime.mutate("closeSubagentQuestion", {
    conversationKey: conversationKey,
  });
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
/** One page of child messages to a parent whose reply is overdue at `before`. */
export function listOverdueSubagentQuestions(
  before: number,
  cursor: string | null,
): Promise<{
  page: AsyncAgentResultRecord[];
  cursor: string;
  isDone: boolean;
}> {
  return runtime.query("listOverdueSubagentQuestions", {
    before: before,
    cursor: cursor,
  });
}
/**
 * Moves a subagent result's hand-back: `detached` when this run gives up, `stored` when the
 * parent is never told. A failed write is only logged: the recovery sweep delivers the row later.
 */
export async function markAsyncAgentHandback(
  eventId: string,
  handback: HandbackMove,
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
