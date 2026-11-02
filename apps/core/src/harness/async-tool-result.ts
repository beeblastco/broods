import type {
  Handback,
  HandbackMove,
  SweptHandback,
} from "@broods/convex/model/subagentResults";
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
  handback?: Handback;
  // The settle fails once the reservation stops naming this machine. Vercel reuses one id
  // across replacements, so the fence never trips there.
  sandbox?: ReservedSandbox;
  expiresAt: number;
}
export function bindAsyncToolResultSandbox(
  resultId: string,
  sandbox: ReservedSandbox,
): Promise<null> {
  return runtime.mutate("bindAsyncToolResultSandbox", {
    resultId: resultId,
    sandbox: sandbox,
  });
}
// The parent event is unique to the row, so settling it resumes the conversation alone.
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
/** Reads one async tool row; the handler uses it for callbacks, answers and continuation runs. */
export function getAsyncToolResult(
  resultId: string,
): Promise<AsyncToolResultRecord | null> {
  return runtime.query("getAsyncToolResult", { resultId: resultId });
}
/** Settles a still-processing row as completed; `async_status` calls it. */
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
export function listOwedAsyncToolResults(options: {
  handback: SweptHandback;
  status: AsyncToolStatus;
  updatedAfter: string;
  updatedBefore: string;
  cursor: string | null;
}): Promise<{
  page: AsyncToolResultRecord[];
  cursor: string;
  isDone: boolean;
}> {
  return runtime.query("listOwedAsyncToolResults", options);
}
// True when a queued continuation will deliver it: the caller must not hand it over itself.
export async function markAsyncToolHandback(
  resultId: string,
  handback: HandbackMove,
): Promise<void> {
  try {
    await runtime.mutate("markAsyncToolHandback", {
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
// Only these tags end the root: a person's own event id may start with `async-` too.
const CONTINUATION_TAG = /:async-(?:bg|question|subagent|tools)(?::|$)/;

export function rootEventId(eventId: string): string {
  const index = eventId.search(CONTINUATION_TAG);

  return index === -1 ? eventId : eventId.slice(0, index);
}
// Root event, not parent: a detached row's parent event id already names the row.
export function asyncToolContinuationEventId(
  row: Pick<AsyncToolResultRecord, "parentEventId" | "resultId">,
): string {
  return `${rootEventId(row.parentEventId)}:async-tools:${row.resultId}`;
}

// A callback runs outside any run's context, so it passes the run's `secretValues` itself.
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
export function verifyAsyncToolCompletionToken(
  resultId: string,
  completionToken: string,
): Promise<boolean> {
  return runtime.query("getAsyncToolToken", {
    resultId: resultId,
    completionToken: completionToken,
  });
}
