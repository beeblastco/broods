import type { ToolSet } from "ai";
import type { Session } from "./session.ts";

const AsyncGeneratorFunction = Object.getPrototypeOf(
  async function* (): AsyncGenerator<never, void, void> {},
).constructor as new () => unknown;

export type ToolExecute = NonNullable<ToolSet[string]["execute"]>;

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

// The SDK streams only when execute returns an AsyncIterable, and a wrapper must pick its
// shape before it starts the tool, so this checks the function, not a call's result.
export function isStreamingExecute(execute: ToolExecute): boolean {
  return execute instanceof AsyncGeneratorFunction;
}

// Only awaited onToolExecutionStart callbacks can reorder calls, so `reserve` before those.
export function serializeToolCalls(
  tools: ToolSet,
  name: string,
): {
  tools: ToolSet;
  reserve: (toolCall: { toolName: string; toolCallId: string }) => void;
} {
  const tool = tools[name];
  if (typeof tool?.execute !== "function" || isStreamingExecute(tool.execute)) {
    return { tools: tools, reserve: (): void => {} };
  }
  const call = tool.execute;
  const turns = new Map<string, ReturnType<typeof takeTurn>>();
  let last: Promise<void> = Promise.resolve();

  return {
    tools: {
      ...tools,
      [name]: {
        ...tool,
        execute: async (...args: Parameters<ToolExecute>): Promise<unknown> => {
          const [, { toolCallId, abortSignal }] = args;
          const turn = turns.get(toolCallId) ?? takeTurn(toolCallId);
          turns.delete(toolCallId);
          const stopped = Promise.withResolvers<void>();
          const stop = (): void => stopped.resolve();
          abortSignal?.addEventListener("abort", stop, { once: true });
          try {
            if (!abortSignal?.aborted) {
              await Promise.race([turn.after, stopped.promise]);
            }
            abortSignal?.throwIfAborted();

            return await call(...args);
          } finally {
            abortSignal?.removeEventListener("abort", stop);
            // A dropped call still frees the next only after the one before it.
            void turn.after.then(turn.done);
          }
        },
      } as ToolSet[string],
    },
    reserve: (toolCall: { toolName: string; toolCallId: string }): void => {
      if (toolCall.toolName === name) takeTurn(toolCall.toolCallId);
    },
  };

  function takeTurn(toolCallId: string): {
    after: Promise<void>;
    done: () => void;
  } {
    const done = Promise.withResolvers<void>();
    const turn = { after: last, done: done.resolve };
    turns.set(toolCallId, turn);
    last = done.promise;

    return turn;
  }
}

// The SDK takes a streaming tool's last yield as its result, so `after` maps that one.
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
