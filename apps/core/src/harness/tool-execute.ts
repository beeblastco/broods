/**
 * The one invariant every tool-execute wrapper must hold: the AI SDK streams a
 * tool only when execute returns an AsyncIterable, so an `async` wrapper turns a
 * streaming tool into a Promise the SDK hands back unread. Wrappers go through
 * wrapToolExecute rather than re-deriving that branch each time.
 */

import type { ToolSet } from "ai";
import type { Session } from "./session.ts";

export type ToolExecute = NonNullable<ToolSet[string]["execute"]>;

/** Runs around a tool call: `before` gates/rewrites input, `after` its result. */
export interface ToolExecuteHooks {
  before?: (input: unknown) => Promise<unknown>;
  after?: (output: unknown) => Promise<unknown>;
}

const AsyncGeneratorFunction = Object.getPrototypeOf(
  async function* (): AsyncGenerator<never, void, void> {},
).constructor as new () => unknown;

/**
 * Wraps every executable tool in a set, preserving whether each one streams.
 * A streaming tool's yields pass straight through; `after` applies to the last
 * one, which is the value the SDK takes as the tool's result.
 */
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

/** Revalidates the fencing token immediately before any executable tool starts. */
export function wrapToolsWithOwnerFence(
  tools: ToolSet,
  session: Pick<Session, "assertCurrentOwner">,
): ToolSet {
  return wrapToolExecute(tools, () => ({
    before: async (input: unknown) => {
      await session.assertCurrentOwner?.();

      return input;
    },
  }));
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
