/**
 * Async external tool coordination.
 * Keep tool wrapping and parent-result injection outside individual tool files.
 */

import type { ToolSet, UserModelMessage } from "ai";
import { logError, logInfo, logWarn } from "../_shared/log.ts";
import {
  createPendingAsyncToolResult,
  type AsyncToolDelivery,
  markAsyncToolResultCompleted,
  markAsyncToolResultFailed,
} from "./async-tool-result.ts";
import type { Session } from "./session.ts";

const DEFAULT_ASYNC_TOOL_WAIT_BUDGET_MS = 8 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface AsyncToolPendingResult {
  resultId: string;
  toolName: string;
  toolCallId: string;
  status: "running";
  statusReference: {
    table: "AsyncToolResult";
    resultId: string;
  };
}

export interface AsyncToolCompletion {
  resultId: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  status: "completed" | "failed";
  response?: unknown;
  error?: string;
}

interface AsyncToolPendingMetadata {
  resultId: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
}

type ToolEntry = ToolSet[string];
type ToolExecute = NonNullable<ToolEntry["execute"]>;

export type AsyncToolExecutionMode = "same-invocation" | "external-dispatch";
export type AsyncToolModeMap = Map<string, AsyncToolExecutionMode>;
export type RunAsyncToolDispatch = (tools: ToolSet, asyncToolModes: AsyncToolModeMap) => ToolSet;

export class AsyncToolCoordinator {
  private readonly completions: AsyncToolCompletion[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private readonly pendingMetadata = new Map<string, AsyncToolPendingMetadata>();
  private readonly waiters = new Set<() => void>();
  private externalDispatchCount = 0;

  constructor(
    private readonly parentSession: Session,
    private readonly waitUntilMs: number = Date.now() + DEFAULT_ASYNC_TOOL_WAIT_BUDGET_MS,
    private readonly supportedExecutionModes: ReadonlySet<AsyncToolExecutionMode> = new Set<AsyncToolExecutionMode>(["same-invocation", "external-dispatch"]),
    private readonly delivery?: AsyncToolDelivery,
  ) { }

  dispatch: RunAsyncToolDispatch = (tools: ToolSet, asyncToolModes: AsyncToolModeMap): ToolSet => {
    if (asyncToolModes.size === 0) {
      return tools;
    }

    return Object.fromEntries(
      Object.entries(tools).map(([toolName, entry]) => {
        const executionMode = asyncToolModes.get(toolName);
        return [
          toolName,
          executionMode ? this.wrapTool(toolName, entry, executionMode) : entry,
        ];
      }),
    ) satisfies ToolSet;
  };

  get pendingCount(): number {
    return this.pending.size;
  }

  get hasExternalDispatches(): boolean {
    return this.externalDispatchCount > 0;
  }

  async waitForIdle(options: {
    onHeartbeat?: (pendingCount: number) => void;
  } = {}): Promise<"idle" | "timeout"> {
    while (this.pending.size > 0 && Date.now() < this.waitUntilMs) {
      const heartbeatAt = Math.min(Date.now() + HEARTBEAT_INTERVAL_MS, this.waitUntilMs);
      await Promise.race([
        this.nextStateChange(),
        new Promise((resolve) => setTimeout(resolve, Math.max(heartbeatAt - Date.now(), 0))),
      ]);

      if (this.pending.size > 0) {
        options.onHeartbeat?.(this.pending.size);
      }
    }

    return this.pending.size === 0 ? "idle" : "timeout";
  }

  async drainCompletionsToParent(): Promise<number> {
    if (this.completions.length === 0) {
      return 0;
    }

    const completions = this.completions.splice(0);
    await this.parentSession.persistModelMessages(completions.map(completionToParentMessage));
    return completions.length;
  }

  async drainCompletionsAndTimeoutsToParent(): Promise<number> {
    if (this.completions.length === 0 && this.pending.size === 0) {
      return 0;
    }

    const completions = this.completions.splice(0);
    const timeouts = [...this.pendingMetadata.values()].map((metadata): AsyncToolCompletion => ({
      ...metadata,
      status: "failed",
      error: "Async tool call is still pending near the parent request timeout.",
    }));

    await Promise.all(timeouts.map((timeout) =>
      markAsyncToolResultFailed({
        resultId: timeout.resultId,
        error: timeout.error ?? "Async tool call timed out",
      }).catch((error) => {
        logError("Failed to mark async tool timeout", {
          resultId: timeout.resultId,
          toolName: timeout.toolName,
          error: error instanceof Error ? error.message : String(error),
        });
      })
    ));

    this.pending.clear();
    this.pendingMetadata.clear();
    const batch = [...completions, ...timeouts];
    await this.parentSession.persistModelMessages(batch.map(completionToParentMessage));
    return batch.length;
  }

  private wrapTool(toolName: string, entry: ToolEntry, executionMode: AsyncToolExecutionMode): ToolEntry {
    if (!this.supportedExecutionModes.has(executionMode)) {
      throw new Error(`Async tool ${toolName} uses ${executionMode}, which is not supported by this request path`);
    }

    if (!entry.execute) {
      logWarn("Async tool config ignored because tool has no local execute", {
        toolName,
        conversationKey: this.parentSession.conversationKey,
        eventId: this.parentSession.eventId,
      });
      return entry;
    }

    const originalExecute = entry.execute.bind(entry) as ToolExecute;
    const wrapped = {
      ...entry,
      outputSchema: undefined,
      toModelOutput: undefined,
      execute: async (input: never, options: Parameters<ToolExecute>[1]): Promise<AsyncToolPendingResult> => {
        const resultId = `async_tool_${crypto.randomUUID()}`;
        await createPendingAsyncToolResult({
          resultId,
          parentEventId: this.parentSession.eventId,
          conversationKey: this.parentSession.conversationKey,
          toolName,
          toolCallId: options.toolCallId,
          input,
          ...(executionMode === "external-dispatch" && this.delivery ? { delivery: this.delivery } : {}),
        });
        const executeOptions = withAsyncToolMetadata(options, {
          resultId,
          parentEventId: this.parentSession.eventId,
          conversationKey: this.parentSession.conversationKey,
        });

        if (executionMode === "external-dispatch") {
          this.externalDispatchCount++;
          await this.dispatchExternalToolCall({
            resultId,
            toolName,
            toolCallId: options.toolCallId,
            input,
            execute: () => originalExecute(input, executeOptions),
          });
        } else {
          this.startToolCall({
            resultId,
            toolName,
            toolCallId: options.toolCallId,
            input,
            execute: () => originalExecute(input, executeOptions),
          });
        }

        return {
          resultId,
          toolName,
          toolCallId: options.toolCallId,
          status: "running",
          statusReference: {
            table: "AsyncToolResult",
            resultId,
          },
        };
      },
    };

    return wrapped as ToolEntry;
  }

  private startToolCall(options: {
    resultId: string;
    toolName: string;
    toolCallId: string;
    input: unknown;
    execute: () => ReturnType<ToolExecute>;
  }): void {
    const promise = this.runToolCall(options)
      .catch((error) => this.completeToolCall({
        resultId: options.resultId,
        toolName: options.toolName,
        toolCallId: options.toolCallId,
        input: options.input,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }))
      .finally(() => {
        this.pending.delete(options.resultId);
        this.pendingMetadata.delete(options.resultId);
        this.notifyCompletion();
      });

    this.pending.set(options.resultId, promise);
    this.pendingMetadata.set(options.resultId, {
      resultId: options.resultId,
      toolName: options.toolName,
      toolCallId: options.toolCallId,
      input: options.input,
    });
  }

  private async dispatchExternalToolCall(options: {
    resultId: string;
    toolName: string;
    toolCallId: string;
    input: unknown;
    execute: () => ReturnType<ToolExecute>;
  }): Promise<void> {
    logInfo("Async tool external dispatch started", {
      parentEventId: this.parentSession.eventId,
      resultId: options.resultId,
      toolName: options.toolName,
      toolCallId: options.toolCallId,
    });

    try {
      await resolveToolOutput(options.execute());
      logInfo("Async tool external dispatch completed", {
        parentEventId: this.parentSession.eventId,
        resultId: options.resultId,
        toolName: options.toolName,
        toolCallId: options.toolCallId,
      });
    } catch (error) {
      await markAsyncToolResultFailed({
        resultId: options.resultId,
        error: error instanceof Error ? error.message : String(error),
      }).catch((markError) => {
        logError("Failed to mark async tool dispatch failed", {
          resultId: options.resultId,
          toolName: options.toolName,
          error: markError instanceof Error ? markError.message : String(markError),
        });
      });
      throw error;
    }
  }

  private async runToolCall(options: {
    resultId: string;
    toolName: string;
    toolCallId: string;
    input: unknown;
    execute: () => ReturnType<ToolExecute>;
  }): Promise<void> {
    logInfo("Async tool call started", {
      parentEventId: this.parentSession.eventId,
      resultId: options.resultId,
      toolName: options.toolName,
      toolCallId: options.toolCallId,
    });

    const response = await resolveToolOutput(options.execute());
    await markAsyncToolResultCompleted({
      resultId: options.resultId,
      response,
    });
    await this.completeToolCall({
      resultId: options.resultId,
      toolName: options.toolName,
      toolCallId: options.toolCallId,
      input: options.input,
      status: "completed",
      response,
    });
  }

  private async completeToolCall(completion: AsyncToolCompletion): Promise<void> {
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

export function completionToParentMessage(completion: AsyncToolCompletion): UserModelMessage {
  const metadata = [
    `resultId: ${completion.resultId}`,
    `toolName: ${completion.toolName}`,
    `status: ${completion.status}`,
  ].join("\n");
  const result = completion.status === "completed"
    ? formatUnknown(completion.response)
    : completion.error;

  return {
    role: "user",
    content: [{
      type: "text",
      text: `Async tool result injected into parent conversation.\n${metadata}\n\nInput:\n${formatUnknown(completion.input)}\n\nResult:\n${result ?? "(no result)"}`,
    }],
  };
}

async function resolveToolOutput(output: ReturnType<ToolExecute>): Promise<unknown> {
  if (isAsyncIterable(output)) {
    let lastOutput: unknown;
    for await (const chunk of output) {
      lastOutput = chunk;
    }
    return lastOutput;
  }

  return output;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value,
  );
}

function withAsyncToolMetadata(
  options: Parameters<ToolExecute>[1],
  metadata: { resultId: string; parentEventId: string; conversationKey: string },
): Parameters<ToolExecute>[1] {
  return {
    ...options,
    asyncTool: {
      resultId: metadata.resultId,
      parentEventId: metadata.parentEventId,
      conversationKey: metadata.conversationKey,
      completePath: `/async-tools/${encodeURIComponent(metadata.resultId)}/complete`,
      statusReference: {
        table: "AsyncToolResult",
        resultId: metadata.resultId,
      },
    },
  } as Parameters<ToolExecute>[1];
}

// Format the tool result from unknown to string
function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
