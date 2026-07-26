/**
 * The one invariant every tool-execute wrapper must hold: the AI SDK streams a
 * tool's output only when execute returns an AsyncIterable, so an `async`
 * wrapper turns a streaming tool into a Promise the SDK hands back unread. Any
 * wrapper (owner fence here, hooks in hook-dispatcher.ts, async-tool
 * coordination in async-tools.ts) checks the shape here and keeps it.
 */

import type { ToolSet } from "ai";
import type { Session } from "./session.ts";

export type ToolExecute = NonNullable<ToolSet[string]["execute"]>;

const AsyncGeneratorFunction = Object.getPrototypeOf(
  async function* (): AsyncGenerator<never, void, void> {},
).constructor as new () => unknown;

/** Revalidates the fencing token immediately before any executable tool starts. */
export function wrapToolsWithOwnerFence(
  tools: ToolSet,
  session: Pick<Session, "assertCurrentOwner">,
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
    // A streaming tool must be re-wrapped as a generator; an async wrapper would
    // hand the SDK a Promise and swallow every yield.
    wrapped[name] = {
      ...tool,
      execute: isStreamingExecute(originalExecute)
        ? async function* (input: unknown, options: unknown) {
            await session.assertCurrentOwner?.();
            const result = call(input, options);
            if (isAsyncIterable(result)) yield* result;
            else yield await result;
          }
        : async (input: unknown, options: unknown) => {
            await session.assertCurrentOwner?.();

            return call(input, options);
          },
    } as ToolSet[string];
  }

  return wrapped;
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
