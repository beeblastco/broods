/**
 * Async tool coordination.
 * Keep tool wrapping and parent-result injection outside individual tool files.
 */

import type { JSONValue, ToolSet, UserModelMessage } from "ai";
import { logError, logInfo, logWarn } from "../shared/log.ts";
import {
  createPendingAsyncToolResult,
  markAsyncToolResultCompleted,
  markAsyncToolResultFailed,
} from "./async-tool-result.ts";
import { toLifecycleValue } from "./lifecycle.ts";
import type { Session } from "./session.ts";
import { isAsyncIterable, type ToolExecute } from "./tool-execute.ts";
import {
  modelValueToUserParts,
  prependTextToUserParts,
} from "./tools/utils.ts";

const DEFAULT_ASYNC_TOOL_WAIT_BUDGET_MS = 8 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

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
    // Moved on when the run yields its worker slot and gets a fresh budget.
    public waitUntilMs: number = Date.now() + DEFAULT_ASYNC_TOOL_WAIT_BUDGET_MS,
  ) {}

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
    await this.parentSession.persistModelMessages(
      completions.map(completionToParentMessage),
    );

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
    await this.parentSession.persistModelMessages(
      batch.map(completionToParentMessage),
    );

    return batch.length;
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
