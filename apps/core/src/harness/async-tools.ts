/**
 * Async tool coordination: the per-run coordinator that wraps `async: true`
 * tools and feeds their results back, and the recovery sweep over results no
 * live run delivered. Keep tool wrapping and parent-result injection outside
 * individual tool files.
 */

import { asyncToolResultDedupeKey } from "@broods/convex/model/subagentResults";
import type { JSONValue, ToolSet, UserModelMessage } from "ai";
import { toErrorMessage } from "../shared/errors.ts";
import { logError, logInfo, logWarn } from "../shared/log.ts";
import {
  createPendingAsyncToolResult,
  listUnobservedAsyncToolResults,
  markAsyncToolHandback,
  markAsyncToolResultCompleted,
  markAsyncToolResultFailed,
  type AsyncToolResultRecord,
} from "./async-tool-result.ts";
import { toLifecycleValue } from "./lifecycle.ts";
import type { ContinuationOutcome } from "./responses.ts";
import type { Session } from "./session.ts";
import { lostResultWindows, SWEPT_HANDBACKS } from "./subagents.ts";
import { isAsyncIterable, type ToolExecute } from "./tool-execute.ts";
import {
  modelValueToUserParts,
  prependTextToUserParts,
} from "./tools/utils.ts";

const DEFAULT_ASYNC_TOOL_WAIT_BUDGET_MS = 8 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Resumes a conversation with a settled row; the handler's `continueAfterAsyncToolSettlement`. */
export type AsyncToolSettlementResumer = (
  settled: AsyncToolResultRecord,
) => Promise<ContinuationOutcome>;

// Per-call context handed to the run/dispatch helpers. toolCallId rides along for
// logging only; it is intentionally absent from the stored metadata/completion.
interface AsyncToolCall extends AsyncToolPendingMetadata {
  toolCallId: string;
  execute: () => ReturnType<ToolExecute>;
}

export interface AsyncToolCompletion {
  resultId: string;
  toolName: string;
  input: unknown;
  status: "completed" | "failed";
  response?: JSONValue;
  error?: string;
}

/** Model-facing names of tools configured `async: true`. */
export type AsyncToolNames = Set<string>;
export type RunAsyncToolDispatch = (
  tools: ToolSet,
  asyncToolNames: AsyncToolNames,
) => ToolSet;

interface AsyncToolPendingMetadata {
  resultId: string;
  toolName: string;
  input: unknown;
}

export interface AsyncToolPendingResult {
  resultId: string;
  status: "running";
}

type ToolEntry = ToolSet[string];

/** Runs `async: true` tools in the background for one turn and feeds their results back; the handler builds one per run. */
export class AsyncToolCoordinator {
  private readonly completions: AsyncToolCompletion[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private readonly pendingMetadata = new Map<
    string,
    AsyncToolPendingMetadata
  >();
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly parentSession: Session,
    private readonly waitUntil: number | (() => number) = Date.now() +
      DEFAULT_ASYNC_TOOL_WAIT_BUDGET_MS,
  ) {}

  // A getter follows the worker's budget as a yielding run moves to a new slot.
  private get waitUntilMs(): number {
    return typeof this.waitUntil === "number"
      ? this.waitUntil
      : this.waitUntil();
  }

  /** Wraps the tools named in `asyncToolNames` so they return a statusId and run in the background. */
  dispatch: RunAsyncToolDispatch = (
    tools: ToolSet,
    asyncToolNames: AsyncToolNames,
  ): ToolSet => {
    if (asyncToolNames.size === 0) {
      return tools;
    }

    return Object.fromEntries(
      Object.entries(tools).map(([toolName, entry]) => [
        toolName,
        asyncToolNames.has(toolName) ? this.wrapTool(toolName, entry) : entry,
      ]),
    );
  };

  /** Calls still running; the handler checks it before waiting. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Waits for in-flight calls up to the wait budget, heartbeating meanwhile; the handler calls it before draining. */
  async waitForIdle(
    options: {
      onHeartbeat?: (pendingCount: number) => void | Promise<void>;
    } = {},
  ): Promise<"idle" | "timeout"> {
    while (this.pending.size > 0 && Date.now() < this.waitUntilMs) {
      const heartbeatAt = Math.min(
        Date.now() + HEARTBEAT_INTERVAL_MS,
        this.waitUntilMs,
      );
      await Promise.race([
        this.nextStateChange(),
        new Promise((resolve) =>
          setTimeout(resolve, Math.max(heartbeatAt - Date.now(), 0)),
        ),
      ]);

      if (this.pending.size > 0) {
        // Awaited, so a heartbeat that finds the run lost ends the wait.
        await options.onHeartbeat?.(this.pending.size);
      }
    }

    return this.pending.size === 0 ? "idle" : "timeout";
  }

  /** Persists finished results into the parent conversation and returns how many; the handler calls it once the wait ends. */
  async drainCompletionsToParent(): Promise<number> {
    if (this.completions.length === 0) {
      return 0;
    }

    const completions = this.completions.splice(0);
    await this.persistToParent(completions);

    return completions.length;
  }

  /** Like `drainCompletionsToParent`, but also fails and injects calls still pending; the handler uses it when the wait timed out. */
  async drainCompletionsAndTimeoutsToParent(): Promise<number> {
    if (this.completions.length === 0 && this.pending.size === 0) {
      return 0;
    }

    const completions = this.completions.splice(0);
    const timeouts = [...this.pendingMetadata.values()].map(
      (metadata): AsyncToolCompletion => ({
        ...metadata,
        status: "failed",
        error:
          "Async tool call is still pending near the parent request timeout.",
      }),
    );

    await Promise.all(
      timeouts.map((timeout) =>
        markAsyncToolResultFailed({
          resultId: timeout.resultId,
          error: timeout.error ?? "Async tool call timed out",
        }).catch((error) => {
          logError("Failed to mark async tool timeout", {
            resultId: timeout.resultId,
            toolName: timeout.toolName,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
    );

    this.pending.clear();
    this.pendingMetadata.clear();
    const batch = [...completions, ...timeouts];
    await this.persistToParent(batch);

    return batch.length;
  }

  /**
   * The one write of finished results into the parent conversation, each
   * under its hand-back key so the insert marks its row stored. When the write
   * fails every row is detached, best effort, and the recovery sweep delivers
   * it; a row whose detach fails too is still `pending`, and the sweep takes
   * it once no live run can hold it.
   */
  private async persistToParent(batch: AsyncToolCompletion[]): Promise<void> {
    try {
      await this.parentSession.persistModelMessages(
        batch.map(completionToParentMessage),
        undefined,
        batch.map(({ resultId, status }): string =>
          asyncToolResultDedupeKey(resultId, status),
        ),
      );
    } catch (error) {
      await Promise.all(
        batch.map(({ resultId }): Promise<void> =>
          markAsyncToolHandback(resultId, "detached"),
        ),
      );
      throw error;
    }
  }

  /** Used by `dispatch`: swaps a tool's execute for one that records a pending row, starts the call, and returns a statusId. */
  private wrapTool(toolName: string, entry: ToolEntry): ToolEntry {
    if (!entry.execute) {
      logWarn("Async tool config ignored because tool has no local execute", {
        toolName: toolName,
        conversationKey: this.parentSession.conversationKey,
        eventId: this.parentSession.eventId,
      });

      return entry;
    }

    const originalExecute = entry.execute.bind(entry) as ToolExecute;
    const wrapped = {
      ...entry,
      outputSchema: undefined,
      toModelOutput: ({ output }: { output: AsyncToolPendingResult }) => ({
        type: "text" as const,
        value: pendingResultText(output.resultId, output.status),
      }),
      execute: async (
        input: never,
        options: Parameters<ToolExecute>[1],
      ): Promise<AsyncToolPendingResult> => {
        const resultId = `async_tool_${crypto.randomUUID()}`;
        await createPendingAsyncToolResult({
          resultId: resultId,
          parentEventId: this.parentSession.eventId,
          conversationKey: this.parentSession.conversationKey,
          toolName: toolName,
          toolCallId: options.toolCallId,
          input: input,
        });
        this.startToolCall({
          resultId: resultId,
          toolName: toolName,
          toolCallId: options.toolCallId,
          input: input,
          execute: () => originalExecute(input, options),
        });

        return { resultId: resultId, status: "running" };
      },
    };

    return wrapped as unknown as ToolEntry;
  }

  /** Runs a wrapped call in the background and tracks it as pending until it settles. */
  private startToolCall(options: AsyncToolCall): void {
    const promise = this.runToolCall(options)
      .catch((error) =>
        this.completeToolCall({
          resultId: options.resultId,
          toolName: options.toolName,
          input: options.input,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        this.pending.delete(options.resultId);
        this.pendingMetadata.delete(options.resultId);
        this.notifyCompletion();
      });

    this.pending.set(options.resultId, promise);
    this.pendingMetadata.set(options.resultId, {
      resultId: options.resultId,
      toolName: options.toolName,
      input: options.input,
    });
  }

  /** Body of `startToolCall`: executes the tool, stores its output as completed, and queues it for the parent. */
  private async runToolCall(options: AsyncToolCall): Promise<void> {
    logInfo("Async tool call started", {
      parentEventId: this.parentSession.eventId,
      resultId: options.resultId,
      toolName: options.toolName,
      toolCallId: options.toolCallId,
    });

    const response = toLifecycleValue(
      canonicalizeAsyncToolOutput(await resolveToolOutput(options.execute())),
    );
    await markAsyncToolResultCompleted({
      resultId: options.resultId,
      ...(response !== undefined ? { response: response } : {}),
    });
    await this.completeToolCall({
      resultId: options.resultId,
      toolName: options.toolName,
      input: options.input,
      status: "completed",
      response: response,
    });
  }

  /** Records a finished call (marking failures in Convex) and queues it for the parent unless a timeout drain already took it. */
  private async completeToolCall(
    completion: AsyncToolCompletion,
  ): Promise<void> {
    const shouldInjectToParent = this.pending.has(completion.resultId);

    if (completion.status === "failed") {
      await markAsyncToolResultFailed({
        resultId: completion.resultId,
        error: completion.error ?? "Async tool call failed",
      }).catch((error) => {
        logError("Failed to mark async tool call failed", {
          resultId: completion.resultId,
          toolName: completion.toolName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    if (!shouldInjectToParent) {
      return;
    }

    this.completions.push(completion);
    this.notifyCompletion();
    logInfo("Async tool call completed", {
      parentEventId: this.parentSession.eventId,
      resultId: completion.resultId,
      toolName: completion.toolName,
      status: completion.status,
    });
  }

  /** Resolves on the next completion or settle; `waitForIdle` races it against the heartbeat. */
  private nextStateChange(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.add(resolve);
    });
  }

  /** Wakes every `nextStateChange` waiter. */
  private notifyCompletion(): void {
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.clear();
  }
}

/**
 * Resumes each conversation whose async tool result no live run delivered:
 * the run that detached it died with its pod or its resume failed, or the
 * result is still `pending` past any live run's hold, because the run that
 * owed it died before its write and its detach. Each pass walks every page,
 * so rows it must retry never crowd the rest out. The ingress recovery sweep
 * calls it on its timer, after the subagent pass.
 */
export async function resumeLostAsyncToolResults(
  resumeConversation: AsyncToolSettlementResumer,
): Promise<void> {
  const now = Date.now();
  const { updatedAfter, finishedBefore } = lostResultWindows(now);
  for (const handback of SWEPT_HANDBACKS) {
    for (const status of ["completed", "failed"] as const) {
      let cursor: string | null = null;
      let isDone = false;
      while (!isDone) {
        const result = await listUnobservedAsyncToolResults({
          handback: handback,
          status: status,
          updatedAfter: updatedAfter,
          updatedBefore: finishedBefore(handback),
          cursor: cursor,
        });
        for (const row of result.page) {
          const handled = await resumeLostAsyncToolResult(
            row,
            resumeConversation,
          );
          // Counted once it is handled: each one is a result a run dropped
          // without a trace. A row kept for the next pass is not counted
          // again each pass.
          if (handled && handback === "pending") {
            logInfo("Async tool result left pending past the run's hold", {
              resultId: row.resultId,
              toolName: row.toolName,
              ageMs: now - Date.parse(row.updatedAt),
              outcome: row.status,
            });
          }
        }
        cursor = result.cursor;
        isDone = result.isDone;
      }
    }
  }
}

/**
 * One row of `resumeLostAsyncToolResults`: its continuation is admitted under
 * the row, so admission stores it, or refuses it as a duplicate once the
 * conversation has it. A conversation with no room keeps the row for the next
 * pass, and so do a resume that throws and a duplicate: admission already
 * marked a stored result, and a continuation still queued marks it when
 * applied, or is admitted again by a later pass once it expired. A row no
 * resume can ever deliver is marked stored and logged once.
 * @returns whether the row is handled, rather than kept for the next pass
 */
async function resumeLostAsyncToolResult(
  row: AsyncToolResultRecord,
  resumeConversation: AsyncToolSettlementResumer,
): Promise<boolean> {
  let outcome: ContinuationOutcome;
  try {
    outcome = await resumeConversation(row);
  } catch (error) {
    logError("Failed to resume a conversation with a lost async tool result", {
      resultId: row.resultId,
      error: toErrorMessage(error),
    });

    return false;
  }
  const admission = outcome.kind === "ready" ? outcome.admission : "skip";
  if (admission === "owner" || admission === "queued") {
    logInfo("Resumed a conversation with a lost async tool result", {
      parentEventId: row.parentEventId,
      resultId: row.resultId,
      admission: admission,
    });

    return true;
  }
  if (admission === "capacity" || admission === "duplicate") return false;
  await markAsyncToolHandback(row.resultId, "stored");
  logInfo("Gave up on a lost async tool result", {
    resultId: row.resultId,
    reason: `resume ${admission}`,
  });

  return true;
}

/** Formats an async tool result as the user message injected into the parent; used by the drains and by the handler's continuation run. */
export function completionToParentMessage(
  completion: AsyncToolCompletion,
): UserModelMessage {
  const metadata = [
    `statusId: ${completion.resultId}`,
    `toolName: ${completion.toolName}`,
    `status: ${completion.status}`,
  ].join("\n");
  const resultParts =
    completion.status === "completed" && completion.response !== undefined
      ? modelValueToUserParts(completion.response)
      : [];
  const prefix = `Async tool result injected into parent conversation.\n${metadata}\n\nInput:\n${formatUnknown(completion.input)}\n\nResult:\n`;

  return {
    role: "user",
    content:
      resultParts.length > 0
        ? prependTextToUserParts(prefix, resultParts)
        : [
            {
              type: "text",
              text: `${prefix}${completion.error ?? "(no result)"}`,
            },
          ],
  };
}

/** Rewrites a binary or URL file part into its JSON form (base64 or href) so it can be stored in Convex. */
function canonicalizeAsyncToolContentPart(part: unknown): unknown {
  if (
    !isRecord(part) ||
    part.type !== "file" ||
    typeof part.mediaType !== "string" ||
    !isRecord(part.data)
  ) {
    return part;
  }

  const data = part.data;
  if (
    data.type === "data" &&
    (data.data instanceof Uint8Array || data.data instanceof ArrayBuffer)
  ) {
    return {
      type: "file-data",
      data: Buffer.from(
        data.data instanceof ArrayBuffer
          ? new Uint8Array(data.data)
          : data.data,
      ).toString("base64"),
      mediaType: part.mediaType,
      ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
      ...(isRecord(part.providerOptions)
        ? { providerOptions: part.providerOptions }
        : {}),
    };
  }

  if (data.type === "url" && data.url instanceof URL) {
    return {
      type: "file-url",
      url: data.url.href,
      mediaType: part.mediaType,
      ...(isRecord(part.providerOptions)
        ? { providerOptions: part.providerOptions }
        : {}),
    };
  }

  return part;
}

/** Canonicalizes each part of a `content` tool output before `runToolCall` stores it. */
function canonicalizeAsyncToolOutput(output: unknown): unknown {
  if (
    !isRecord(output) ||
    output.type !== "content" ||
    !Array.isArray(output.value)
  ) {
    return output;
  }

  return {
    ...output,
    value: output.value.map(canonicalizeAsyncToolContentPart),
  };
}

/** Renders a tool input as text for the injected parent message. */
function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Loose object guard for the tool output canonicalizers. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// Model-facing text for a just-started async tool call. The model already knows
// which tool it called, so only the statusId (needed to poll async_status) matters.
// statusId carries the internal resultId value, renamed at the model boundary.
function pendingResultText(resultId: string, status: string): string {
  return [
    `Started in the background (statusId: ${resultId}, current status: ${status}).`,
    "The result will be delivered back into this conversation automatically when it finishes; You can stop to wait for result, or continue with other tasks. Only poll async_status tool with this statusId to check status if the user asks for it.",
  ].join("\n");
}

/** Awaits a tool's output; for a streaming tool, keeps only the last chunk. */
async function resolveToolOutput(
  output: ReturnType<ToolExecute>,
): Promise<unknown> {
  if (isAsyncIterable(output)) {
    let lastOutput: unknown;
    for await (const chunk of output) {
      lastOutput = chunk;
    }

    return lastOutput;
  }

  return output;
}
