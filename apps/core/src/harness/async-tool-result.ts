/** Async tool result, fan-in, callback, delivery, and observed state in Convex. */

import type { JSONValue } from "ai";
import type { ChannelIdentity } from "../shared/channels.ts";
import { runtime } from "../shared/convex/runtime.ts";
import type { ReservedSandbox } from "./sandbox/types.ts";
export type AsyncToolStatus = "processing" | "completed" | "failed";
export type AsyncToolDelivery =
  | { kind: "async" }
  | {
      kind: "nats";
      connectionId: string;
      publicEventId: string;
      publicConversationKey: string;
    }
  | {
      kind: "channel";
      channelName: string;
      identity?: ChannelIdentity;
      source: Record<string, unknown>;
    };
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
  response?: JSONValue;
  error?: string;
  delivery?: AsyncToolDelivery;
  observed?: boolean;
  // The machine a detached job launched on; Convex fails the settle if the
  // reservation stops naming it. Vercel's id is a name shared by every
  // replacement, so the fence never trips there.
  sandbox?: ReservedSandbox;
  expiresAt: number;
}
export interface DetachedAsyncToolGroup {
  parentEventId: string;
  resultIds: string[];
  sealed: boolean;
}
/** Records the machine a background bash job launched on, so a replaced machine fails its settle. */
export function bindAsyncToolResultSandbox(
  resultId: string,
  sandbox: ReservedSandbox,
): Promise<null> {
  return runtime.mutate("bindAsyncToolResultSandbox", {
    resultId: resultId,
    sandbox: sandbox,
  });
}
/**
 * A one-row group sealed on insert, for a tool that settles on its own later
 * (a background job, an open question). The parent event is derived from the
 * turn that started it.
 */
export function createDetachedAsyncToolResult(options: {
  eventId: string;
  tag: string;
  resultId: string;
  conversationKey: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  delivery: AsyncToolDelivery;
  completionToken?: string;
}): Promise<boolean> {
  const { eventId, tag, ...row } = options;

  return runtime.mutate("createAsyncToolResult", {
    ...row,
    parentEventId: `${eventId}:${tag}:${options.resultId}`,
    sealed: true,
  });
}
/** Inserts a `processing` row for an async tool call; `AsyncToolCoordinator` calls it before the tool starts in the background. */
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
/** Reads one async tool row; the handler uses it for callbacks, answers and continuation runs. */
export function getAsyncToolResult(
  resultId: string,
): Promise<AsyncToolResultRecord | null> {
  return runtime.query("getAsyncToolResult", { resultId: resultId });
}
/** Reads a parent event's dispatch group, ids sorted; the handler uses it to decide whether a settled result can resume the conversation. */
export async function getDetachedAsyncToolGroup(
  parentEventId: string,
): Promise<DetachedAsyncToolGroup | null> {
  const row = await runtime.query<DetachedAsyncToolGroup | null>(
    "getAsyncToolGroup",
    { parentEventId: parentEventId },
  );

  return row
    ? {
        parentEventId: row.parentEventId,
        resultIds: [...row.resultIds].sort(),
        sealed: row.sealed,
      }
    : null;
}
/** Lists every row of a parent event; the handler uses it to build a continuation run. */
export function listAsyncToolResultsByParentEvent(
  parentEventId: string,
): Promise<AsyncToolResultRecord[]> {
  return runtime.query("listAsyncToolResults", {
    parentEventId: parentEventId,
  });
}
/** Settles a still-processing row as completed; the coordinator and `async_status` call it. */
export async function markAsyncToolResultCompleted(options: {
  resultId: string;
  response?: JSONValue;
}): Promise<void> {
  await runtime.mutate("updateAsyncToolResult", {
    resultId: options.resultId,
    status: "completed",
    response: options.response,
    onlyWhenProcessing: true,
  });
}
/** Settles a still-processing row as failed; the coordinator, tools and questions call it. */
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
/** Marks a finished row observed so it is not delivered again; `async_status` calls it. */
export async function markAsyncToolResultObserved(
  resultId: string,
): Promise<void> {
  await runtime.mutate("observeAsyncToolResult", { resultId: resultId });
}
/**
 * The event a person started, for a run that continues it: everything before the
 * first `:async-` segment of a detached or continuation event id. Traces use it to
 * group an answer's run with the run that asked.
 */
export function rootEventId(eventId: string): string {
  const index = eventId.indexOf(":async-");

  return index === -1 ? eventId : eventId.slice(0, index);
}
/** Settles a still-processing row from outside the run, for background job callbacks and question answers. Null when already settled. */
export function settleAsyncToolResultFromCallback(options: {
  resultId: string;
  status: "completed" | "failed";
  response?: JSONValue;
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
/** Checks a callback's completion token against the row; the handler calls it before settling. */
export function verifyAsyncToolCompletionToken(
  resultId: string,
  completionToken: string,
): Promise<boolean> {
  return runtime.query("getAsyncToolToken", {
    resultId: resultId,
    completionToken: completionToken,
  });
}
