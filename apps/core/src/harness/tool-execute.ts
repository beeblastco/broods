/**
 * The one invariant every tool-execute wrapper must hold: the AI SDK streams a
 * tool only when execute returns an AsyncIterable, so an `async` wrapper turns a
 * streaming tool into a Promise the SDK hands back unread. Wrappers go through
 * wrapToolExecute rather than re-deriving that branch each time.
 */

import type { ToolSet } from "ai";
import type { Session } from "./session.ts";

const AsyncGeneratorFunction = Object.getPrototypeOf(
  async function* (): AsyncGenerator<never, void, void> {},
).constructor as new () => unknown;

export type ToolExecute = NonNullable<ToolSet[string]["execute"]>;

/** A tool set whose one serialized tool runs its calls in reserved order. */
export interface ToolCallQueue {
  tools: ToolSet;
  /** Takes the next turn for a call of the serialized tool; others are ignored. */
  reserve: (toolCall: { toolName: string; toolCallId: string }) => void;
}

// `after` settles when the call before it is done; `done` frees the next one.
interface ToolCallTurn {
  after: Promise<void>;
  done: () => void;
}

/** Runs around a tool call: `before` gates/rewrites input, `after` its result. */
export interface ToolExecuteHooks {
  before?: (input: unknown) => Promise<unknown>;
  after?: (output: unknown) => Promise<unknown>;
}

export function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<unknown> {
  return Boolean(
    value && typeof value === "object" && Symbol.asyncIterator in value,
  );
}

/**
 * Whether wrapping this execute must itself stream. Checked on the function, not
 * on a call's return value, because a wrapper has to pick its own shape before
 * it is allowed to start the tool.
 */
export function isStreamingExecute(execute: ToolExecute): boolean {
  return execute instanceof AsyncGeneratorFunction;
}

/**
 * Runs one non-streaming tool's calls one at a time, in the order their turns
 * are reserved. The harness reserves from onToolExecutionStart before its first
 * await, which the SDK reaches in the model's call order; execute itself comes
 * after awaited start callbacks (lifecycle webhooks), hooks and the owner fence,
 * any of which can let a later click or keypress overtake an earlier one. A call
 * nobody reserved takes its turn when execute starts.
 */
export function serializeToolCalls(
  tools: ToolSet,
  name: string,
): ToolCallQueue {
  const tool = tools[name];
  if (typeof tool?.execute !== "function" || isStreamingExecute(tool.execute)) {
    return { tools: tools, reserve: (): void => {} };
  }
  const call = tool.execute;
  const turns = new Map<string, ToolCallTurn>();
  let last: Promise<void> = Promise.resolve();
  const takeTurn = (toolCallId: string): ToolCallTurn => {
    const done = Promise.withResolvers<void>();
    const turn = { after: last, done: done.resolve };
    turns.set(toolCallId, turn);
    last = done.promise;

    return turn;
  };

  return {
    tools: {
      ...tools,
      [name]: {
        ...tool,
        execute: async (...args: Parameters<ToolExecute>): Promise<unknown> => {
          const [, options] = args;
          const turn =
            turns.get(options.toolCallId) ?? takeTurn(options.toolCallId);
          turns.delete(options.toolCallId);
          try {
            await turn.after;
            // A stopped run must not fire the actions still waiting their turn.
            options.abortSignal?.throwIfAborted();

            return await call(...args);
          } finally {
            turn.done();
          }
        },
      } as ToolSet[string],
    },
    reserve: (toolCall: { toolName: string; toolCallId: string }): void => {
      if (toolCall.toolName === name) takeTurn(toolCall.toolCallId);
    },
  };
}

// `after` applies to a streaming tool's last yield, which is the value the SDK
// takes as its result.
export function wrapToolExecute(
  tools: ToolSet,
  hooks: (name: string) => ToolExecuteHooks,
): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const originalExecute = tool.execute;
    if (typeof originalExecute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    const call = originalExecute as (
      input: unknown,
      options: unknown,
    ) => unknown;
    const { before, after } = hooks(name);
    wrapped[name] = {
      ...tool,
      execute: isStreamingExecute(originalExecute)
        ? async function* (input: unknown, options: unknown) {
            const result = call(await runBefore(before, input), options);
            let last: unknown;
            if (isAsyncIterable(result)) {
              for await (const output of result) {
                last = output;
                yield output;
              }
            } else {
              last = await result;
            }
            const settled = await runAfter(after, last);
            if (settled !== last || !isAsyncIterable(result)) yield settled;
          }
        : async (input: unknown, options: unknown) =>
            await runAfter(
              after,
              await call(await runBefore(before, input), options),
            ),
    } as ToolSet[string];
  }

  return wrapped;
}

/**
 * Revalidates the fencing token before any executable tool starts, unless a
 * fenced call proved it within the session's owner check interval.
 */
export function wrapToolsWithOwnerFence(
  tools: ToolSet,
  session: Pick<Session, "assertRecentOwner">,
): ToolSet {
  return wrapToolExecute(tools, () => ({
    before: async (input: unknown) => {
      await session.assertRecentOwner?.();

      return input;
    },
  }));
}

async function runAfter(
  after: ToolExecuteHooks["after"],
  output: unknown,
): Promise<unknown> {
  return after ? await after(output) : output;
}

async function runBefore(
  before: ToolExecuteHooks["before"],
  input: unknown,
): Promise<unknown> {
  return before ? await before(input) : input;
}
