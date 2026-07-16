/** Async tool result, fan-in, callback, delivery, and observed state in Convex. */

import { runtime } from "../shared/convex/runtime.ts";
export type AsyncToolStatus = "processing" | "completed" | "failed";
export type AsyncToolDelivery =
  | { kind: "async" }
  | {
    kind: "nats";
    connectionId: string;
    publicEventId: string;
    publicConversationKey: string;
  }
  | { kind: "channel"; channelName: string; source: Record<string, unknown> };
export interface AsyncToolResultRecord {
  resultId: string;
  parentEventId: string;
  conversationKey: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  status: AsyncToolStatus;
  createdAt: string;
  updatedAt: string;
  response?: unknown;
  error?: string;
  delivery?: AsyncToolDelivery;
  observed?: boolean;
  expiresAt: number;
}
export interface DetachedAsyncToolGroup {
  parentEventId: string;
  resultIds: string[];
  sealed: boolean;
}
export function createPendingAsyncToolResult(options: {
  resultId: string;
  parentEventId: string;
  conversationKey: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  delivery?: AsyncToolDelivery;
  completionToken?: string;
}): Promise<boolean> {
  return runtime.mutate("createAsyncToolResult", options);
}
export function verifyAsyncToolCompletionToken(
  resultId: string,
  completionToken: string,
): Promise<boolean> {
  return runtime.query("getAsyncToolToken", { resultId, completionToken });
}
export async function getDetachedAsyncToolGroup(
  parentEventId: string,
): Promise<DetachedAsyncToolGroup | null> {
  const row = await runtime.query<DetachedAsyncToolGroup | null>(
    "getAsyncToolGroup",
    { parentEventId },
  );
  return row
    ? {
      parentEventId: row.parentEventId,
      resultIds: [...row.resultIds].sort(),
      sealed: row.sealed,
    }
    : null;
}
export async function sealDetachedAsyncToolGroup(
  parentEventId: string,
): Promise<DetachedAsyncToolGroup | null> {
  const row = await runtime.mutate<DetachedAsyncToolGroup | null>(
    "sealAsyncToolGroup",
    { parentEventId },
  );
  return row
    ? {
      parentEventId: row.parentEventId,
      resultIds: [...row.resultIds].sort(),
      sealed: row.sealed,
    }
    : null;
}
export function listAsyncToolResultsByParentEvent(
  parentEventId: string,
): Promise<AsyncToolResultRecord[]> {
  return runtime.query("listAsyncToolResults", { parentEventId });
}
export function getAsyncToolResult(
  resultId: string,
): Promise<AsyncToolResultRecord | null> {
  return runtime.query("getAsyncToolResult", { resultId });
}
export async function markAsyncToolResultObserved(
  resultId: string,
): Promise<void> {
  const row = await getAsyncToolResult(resultId);
  if (row && row.status !== "processing")
    await runtime.mutate("updateAsyncToolResult", {
      resultId,
      status: row.status,
      observed: true,
    });
}
export async function markAsyncToolResultCompleted(options: {
  resultId: string;
  response: unknown;
}): Promise<void> {
  await runtime.mutate("updateAsyncToolResult", {
    resultId: options.resultId,
    status: "completed",
    response: options.response,
    onlyWhenProcessing: true,
  });
}
export async function markAsyncToolResultFailed(options: {
  resultId: string;
  error: string;
}): Promise<void> {
  await runtime.mutate("updateAsyncToolResult", {
    resultId: options.resultId,
    status: "failed",
    error: options.error,
    onlyWhenProcessing: true,
  });
}
export function settleAsyncToolResultFromCallback(options: {
  resultId: string;
  status: "completed" | "failed";
  response?: unknown;
  error?: string;
}): Promise<AsyncToolResultRecord | null> {
  return runtime.mutate("updateAsyncToolResult", {
    resultId: options.resultId,
    status: options.status,
    onlyWhenProcessing: true,
    ...(options.status === "completed"
      ? { response: options.response }
      : { error: options.error ?? "Async tool call failed" }),
  });
}
