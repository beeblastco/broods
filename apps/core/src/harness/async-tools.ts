import {
  asyncToolResultDedupeKey,
  SWEPT_HANDBACKS,
} from "@broods/convex/model/subagentResults";
import type { JSONValue, ToolSet, UserModelMessage } from "ai";
import { toErrorMessage } from "../shared/errors.ts";
import { logError, logInfo, logWarn } from "../shared/log.ts";
import {
  createPendingAsyncToolResult,
  listOwedAsyncToolResults,
  markAsyncToolHandback,
  markAsyncToolResultCompleted,
  markAsyncToolResultFailed,
  type AsyncToolResultRecord,
} from "./async-tool-result.ts";
import { toLifecycleValue } from "./lifecycle.ts";
import type { ContinuationOutcome } from "./responses.ts";
import type { Session } from "./session.ts";
import { lostResultWindows } from "./subagents.ts";
import { isAsyncIterable, type ToolExecute } from "./tool-execute.ts";
import {
  modelValueToUserParts,
  parseToolResultOutput,
  prependTextToUserParts,
  type ToolContentPart,
} from "./tools/utils.ts";

const DEFAULT_ASYNC_TOOL_WAIT_BUDGET_MS = 8 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export type AsyncToolSettlementResumer = (
  settled: AsyncToolResultRecord,
) => Promise<ContinuationOutcome>;

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

  // A function follows the worker's budget as a yielding run moves to a new slot.
  private get waitUntilMs(): number {
    return typeof this.waitUntil === "number"
      ? this.waitUntil
      : this.waitUntil();
  }

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

  get pendingCount(): number {
    return this.pending.size;
  }

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

  async drainCompletionsToParent(): Promise<number> {
    if (this.completions.length === 0) {
      return 0;
    }

    const completions = this.completions.splice(0);
    await this.persistToParent(completions);

    return completions.length;
  }

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

  // On failure the sweep delivers each row: detached, or still pending if the detach fails too.
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
        batch.map(({ resultId }): Promise<boolean> =>
          markAsyncToolHandback(resultId, "detached"),
        ),
      );
      throw error;
    }
  }

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

  private async completeToolCall(
    completion: AsyncToolCompletion,
  ): Promise<void> {
    // No longer pending once a timeout drain has already injected it.
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

  private nextStateChange(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.add(resolve);
    });
  }

  private notifyCompletion(): void {
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.clear();
  }
}

// Each pass walks every page, so rows kept for a retry never crowd the rest out.
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
        const result = await listOwedAsyncToolResults({
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
          // Logged once, when handled: each is a result a run dropped without a trace.
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

/** @returns false to keep the row for the next pass. */
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
  // Kept: a duplicate is already marked stored, or its queued continuation marks it
  // when applied, or expires and a later pass admits it again.
  if (admission === "capacity" || admission === "duplicate") return false;
  await markAsyncToolHandback(row.resultId, "stored");
  logInfo("Gave up on a lost async tool result", {
    resultId: row.resultId,
    reason: `resume ${admission}`,
  });

  return true;
}

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

// Binary and URL file parts become their JSON form, which Convex can store.
function canonicalizeAsyncToolContentPart(
  part: ToolContentPart,
): ToolContentPart {
  if (part.type !== "file") {
    return part;
  }

  const { data } = part;
  if (data.type === "data" && typeof data.data !== "string") {
    return {
      type: "file-data",
      data: Buffer.from(
        data.data instanceof ArrayBuffer
          ? new Uint8Array(data.data)
          : data.data,
      ).toString("base64"),
      mediaType: part.mediaType,
      ...(part.filename !== undefined ? { filename: part.filename } : {}),
      ...(part.providerOptions
        ? { providerOptions: part.providerOptions }
        : {}),
    };
  }

  if (data.type === "url") {
    return {
      type: "file-url",
      url: data.url.href,
      mediaType: part.mediaType,
      ...(part.providerOptions
        ? { providerOptions: part.providerOptions }
        : {}),
    };
  }

  return part;
}

function canonicalizeAsyncToolOutput(output: unknown): unknown {
  const parsed = parseToolResultOutput(output);
  if (parsed?.type !== "content") {
    return output;
  }

  return {
    ...parsed,
    value: parsed.value.map(canonicalizeAsyncToolContentPart),
  };
}

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

// `statusId` is the resultId under its model-facing name.
function pendingResultText(resultId: string, status: string): string {
  return [
    `Started in the background (statusId: ${resultId}, current status: ${status}).`,
    "The result will be delivered back into this conversation automatically when it finishes; You can stop to wait for result, or continue with other tasks. Only poll async_status tool with this statusId to check status if the user asks for it.",
  ].join("\n");
}

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
