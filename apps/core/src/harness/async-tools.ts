/**
 * Async tool coordination.
 * Keep tool wrapping and parent-result injection outside individual tool files.
 */

import type { ToolSet, UserModelMessage } from "ai";
import { logError, logInfo, logWarn } from "../shared/log.ts";
import {
  createPendingAsyncToolResult,
  markAsyncToolResultCompleted,
  markAsyncToolResultFailed,
  type AsyncToolDelivery,
} from "./async-tool-result.ts";
import type { Session } from "./session.ts";

const DEFAULT_ASYNC_TOOL_WAIT_BUDGET_MS = 8 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface AsyncToolPendingResult {
  resultId: string;
  status: "running";
}

export interface AsyncToolCompletion {
  resultId: string;
  toolName: string;
  input: unknown;
  status: "completed" | "failed";
  response?: unknown;
  error?: string;
}

interface AsyncToolPendingMetadata {
  resultId: string;
  toolName: string;
  input: unknown;
}

// Per-call context handed to the run/dispatch helpers. toolCallId rides along for
// logging only; it is intentionally absent from the stored metadata/completion.
interface AsyncToolCall extends AsyncToolPendingMetadata {
  toolCallId: string;
  execute: () => ReturnType<ToolExecute>;
}

type ToolEntry = ToolSet[string];
type ToolExecute = NonNullable<ToolEntry["execute"]>;

export type AsyncToolSource = "built-in" | "uploaded";
export type AsyncToolModeMap = Map<string, AsyncToolSource>;
export type RunAsyncToolDispatch = (tools: ToolSet, asyncToolModes: AsyncToolModeMap) => ToolSet;

export class AsyncToolCoordinator {
  private readonly completions: AsyncToolCompletion[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private readonly pendingMetadata = new Map<string, AsyncToolPendingMetadata>();
  private readonly waiters = new Set<() => void>();
  private detachedCallbackCount = 0;

  constructor(
    private readonly parentSession: Session,
    private readonly waitUntilMs: number = Date.now() + DEFAULT_ASYNC_TOOL_WAIT_BUDGET_MS,
    private readonly delivery?: AsyncToolDelivery,
  ) { }

  dispatch: RunAsyncToolDispatch = (tools: ToolSet, asyncToolModes: AsyncToolModeMap): ToolSet => {
    if (asyncToolModes.size === 0) {
      return tools;
    }

    return Object.fromEntries(
      Object.entries(tools).map(([toolName, entry]) => {
        const source = asyncToolModes.get(toolName);
        return [
          toolName,
          source ? this.wrapTool(toolName, entry, source) : entry,
        ];
      }),
    ) satisfies ToolSet;
  };

  get pendingCount(): number {
    return this.pending.size;
  }

  get hasDetachedCallbacks(): boolean {
    return this.detachedCallbackCount > 0;
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

  private wrapTool(toolName: string, entry: ToolEntry, source: AsyncToolSource): ToolEntry {
    if (!entry.execute) {
      logWarn("Async tool config ignored because tool has no local execute", {
        toolName,
        conversationKey: this.parentSession.conversationKey,
        eventId: this.parentSession.eventId,
      });
      return entry;
    }

    const originalExecute = entry.execute.bind(entry) as ToolExecute;
    const detachedCallback = source === "uploaded" && this.delivery !== undefined;
    const wrapped = {
      ...entry,
      outputSchema: undefined,
      toModelOutput: ({ output }: { output: AsyncToolPendingResult }) => ({
        type: "text" as const,
        value: pendingResultText(
          output.resultId,
          output.status,
        ),
      }),
      execute: async (input: never, options: Parameters<ToolExecute>[1]): Promise<AsyncToolPendingResult> => {
        const resultId = `async_tool_${crypto.randomUUID()}`;
        const completionToken = detachedCallback ? crypto.randomUUID() : undefined;
        await createPendingAsyncToolResult({
          resultId,
          parentEventId: this.parentSession.eventId,
          conversationKey: this.parentSession.conversationKey,
          toolName,
          toolCallId: options.toolCallId,
          input,
          ...(detachedCallback && this.delivery ? { delivery: this.delivery } : {}),
          ...(completionToken ? { completionToken } : {}),
        });
        const executeOptions = withAsyncToolMetadata(options, {
          resultId,
          parentEventId: this.parentSession.eventId,
          conversationKey: this.parentSession.conversationKey,
          ...(detachedCallback ? { detached: true } : {}),
          ...(completionToken ? { completionToken } : {}),
        });

        if (detachedCallback) {
          this.detachedCallbackCount++;
          await this.dispatchDetachedToolCall({
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

        return { resultId, status: "running" };
      },
    };

    return wrapped as unknown as ToolEntry;
  }

  private startToolCall(options: AsyncToolCall): void {
    const promise = this.runToolCall(options)
      .catch((error) => this.completeToolCall({
        resultId: options.resultId,
        toolName: options.toolName,
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
      input: options.input,
    });
  }

  private async dispatchDetachedToolCall(options: AsyncToolCall): Promise<void> {
    logInfo("Detached async tool started", {
      parentEventId: this.parentSession.eventId,
      resultId: options.resultId,
      toolName: options.toolName,
      toolCallId: options.toolCallId,
    });

    try {
      await resolveToolOutput(options.execute());
      logInfo("Detached async tool launch completed", {
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
        logError("Failed to mark detached async tool failed", {
          resultId: options.resultId,
          toolName: options.toolName,
          error: markError instanceof Error ? markError.message : String(markError),
        });
      });
      throw error;
    }
  }

  private async runToolCall(options: AsyncToolCall): Promise<void> {
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
    `statusId: ${completion.resultId}`,
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
  metadata: {
    resultId: string;
    parentEventId: string;
    conversationKey: string;
    detached?: boolean;
    completionToken?: string;
  },
): Parameters<ToolExecute>[1] {
  return {
    ...options,
    asyncTool: {
      resultId: metadata.resultId,
      parentEventId: metadata.parentEventId,
      conversationKey: metadata.conversationKey,
      completePath: metadata.detached === true
        ? `/sandbox-jobs/${encodeURIComponent(metadata.resultId)}/complete`
        : `/async-tools/${encodeURIComponent(metadata.resultId)}/complete`,
      ...(metadata.detached === true ? { detached: true } : {}),
      ...(metadata.completionToken ? { completionToken: metadata.completionToken } : {}),
    },
  } as Parameters<ToolExecute>[1];
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

// Format the tool result from unknown to string
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
