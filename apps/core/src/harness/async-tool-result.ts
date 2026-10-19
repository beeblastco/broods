/** Async tool result, callback, delivery, and hand-back state in Convex. */

import type { Handback } from "@broods/convex/model/subagentResults";
import type { JSONValue } from "ai";
import type { ChannelIdentity } from "../shared/channels.ts";
import { runtime } from "../shared/convex/runtime.ts";
import { toErrorMessage } from "../shared/errors.ts";
import {
  logError,
  redactWithRunSecrets,
  runSecretValues,
} from "../shared/log.ts";
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
  // True once the model read the result with async_status. Written by the
  // release before `handback`; read beside it for one release.
  observed?: boolean;
  // Where a finished result stands with the run that started it: `pending`
  // until that run stores it, `detached` once it gave up and the recovery
  // sweep owns it, `stored` once the conversation has it.
  handback?: Handback;
  // The machine a detached job launched on; Convex fails the settle if the
  // reservation stops naming it. Vercel's id is a name shared by every
  // replacement, so the fence never trips there.
  sandbox?: ReservedSandbox;
  expiresAt: number;
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
 * A row for a tool that settles on its own later (a background job, an open
 * question). Its parent event is unique to the row, derived from the turn that
 * started it, so settling it resumes the conversation alone.
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
    input: redactWithRunSecrets(options.input),
    parentEventId: `${eventId}:${tag}:${options.resultId}`,
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
  return runtime.mutate("createAsyncToolResult", {
    ...options,
    input: redactWithRunSecrets(options.input),
  });
}
/** Reads one async tool row; the handler uses it for callbacks, answers and continuation runs. */
export function getAsyncToolResult(
  resultId: string,
): Promise<AsyncToolResultRecord | null> {
  return runtime.query("getAsyncToolResult", { resultId: resultId });
}
/** Settles a still-processing row as completed; the coordinator and `async_status` call it. */
export async function markAsyncToolResultCompleted(options: {
  resultId: string;
  response?: JSONValue;
}): Promise<void> {
  await runtime.mutate("updateAsyncToolResult", {
    resultId: options.resultId,
    status: "completed",
    response: redactWithRunSecrets(options.response),
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
    error: redactWithRunSecrets(options.error),
    onlyWhenProcessing: true,
  });
}
/**
 * One page of async tool results in `status` whose hand-back is `handback`,
 * written in the window, from `cursor`. The recovery sweep walks every page.
 */
export function listUnobservedAsyncToolResults(options: {
  handback: Exclude<Handback, "stored">;
  status: AsyncToolStatus;
  updatedAfter: string;
  updatedBefore: string;
  cursor: string | null;
}): Promise<{
  page: AsyncToolResultRecord[];
  cursor: string;
  isDone: boolean;
}> {
  return runtime.query("listUnobservedAsyncToolResults", options);
}
/**
 * Moves a finished result's hand-back: `detached` when the run that started it
 * gives up delivering it, `stored` when the model reads it with async_status.
 * A stored row stays stored. The row already holds the result, so a failed
 * write is only logged: a pending row reaches the recovery sweep later.
 */
export async function markAsyncToolHandback(
  resultId: string,
  handback: Exclude<Handback, "pending">,
): Promise<void> {
  try {
    await runtime.mutate("observeAsyncToolResult", {
      resultId: resultId,
      handback: handback,
    });
  } catch (error) {
    logError("Failed to record an async tool result's hand-back", {
      resultId: resultId,
      handback: handback,
      error: toErrorMessage(error),
    });
  }
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
/**
 * Settles a still-processing row from outside the run, for background job
 * callbacks and question answers. Null when already settled. `secretValues`
 * are the run's own, from a caller that no run's context covers.
 */
export function settleAsyncToolResultFromCallback(options: {
  resultId: string;
  status: "completed" | "failed";
  response?: JSONValue;
  error?: string;
  secretValues?: readonly string[];
}): Promise<AsyncToolResultRecord | null> {
  const secretValues = [...runSecretValues(), ...(options.secretValues ?? [])];

  return runtime.mutate("updateAsyncToolResult", {
    resultId: options.resultId,
    status: options.status,
    onlyWhenProcessing: true,
    ...(options.status === "completed"
      ? { response: redactWithRunSecrets(options.response, secretValues) }
      : {
          error: redactWithRunSecrets(
            options.error ?? "Async tool call failed",
            secretValues,
          ),
        }),
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
