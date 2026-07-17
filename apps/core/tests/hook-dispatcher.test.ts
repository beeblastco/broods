/**
 * Tool-execute wrapper tests: a tool.call.started hook can deny or edit args and
 * a tool.result hook can transform output. Real isolate execution + the
 * config→dispatcher→isolate→mutation path are covered in hooks-integration.test.ts
 * and hook-runner.test.ts; here the dispatcher is a local fake.
 */

import { describe, expect, it } from "bun:test";
import type { ToolSet } from "ai";
import type { AgentHookEventName } from "../src/shared/domain/agent-config.ts";
import type { HookDispatcher } from "../src/harness/hook-dispatcher.ts";
import { wrapToolsWithHooks } from "../src/harness/hook-dispatcher.ts";

function fakeTool(execute: (input: unknown) => unknown): ToolSet[string] {
  return {
    execute: async (input: unknown) => execute(input),
  } as unknown as ToolSet[string];
}

function dispatcherReturning(
  responder: (
    event: AgentHookEventName,
    payload: Record<string, unknown>,
  ) => Record<string, unknown> | undefined,
  events: AgentHookEventName[] = ["tool.call.started", "tool.result"],
): HookDispatcher {
  return {
    hasHooksFor: (event) => events.includes(event),
    async runMutation(event, payload) {
      return responder(event, payload as Record<string, unknown>);
    },
  };
}

describe("wrapToolsWithHooks", () => {
  it("returns the same ToolSet when no tool-scoped hooks exist", () => {
    const tools: ToolSet = { echo: fakeTool((input) => input) };
    const wrapped = wrapToolsWithHooks(
      tools,
      dispatcherReturning(() => undefined, []),
    );
    expect(wrapped).toBe(tools);
  });

  it("denies a tool call when the hook returns decision: deny", async () => {
    const tools: ToolSet = { bash: fakeTool(() => "ran") };
    const wrapped = wrapToolsWithHooks(
      tools,
      dispatcherReturning((event) =>
        event === "tool.call.started"
          ? { decision: "deny", denyReason: "no shell" }
          : undefined,
      ),
    );
    await expect(
      (wrapped.bash!.execute as (i: unknown, o: unknown) => Promise<unknown>)(
        { cmd: "ls" },
        {},
      ),
    ).rejects.toThrow(/blocked by hook: no shell/);
  });

  it("edits tool args before execution", async () => {
    let seen: unknown;
    const tools: ToolSet = {
      search: fakeTool((input) => {
        seen = input;
        return "ok";
      }),
    };
    const wrapped = wrapToolsWithHooks(
      tools,
      dispatcherReturning((event) =>
        event === "tool.call.started"
          ? { decision: "allow", args: { query: "edited" } }
          : undefined,
      ),
    );
    const result = await (
      wrapped.search!.execute as (i: unknown, o: unknown) => Promise<unknown>
    )({ query: "original" }, {});
    expect(seen).toEqual({ query: "edited" });
    expect(result).toBe("ok");
  });

  it("transforms tool output via a tool.result hook", async () => {
    const tools: ToolSet = { calc: fakeTool(() => ({ value: 1 })) };
    const wrapped = wrapToolsWithHooks(
      tools,
      dispatcherReturning((event) =>
        event === "tool.result"
          ? { output: { value: 99 } }
          : { decision: "allow" },
      ),
    );
    const result = await (
      wrapped.calc!.execute as (i: unknown, o: unknown) => Promise<unknown>
    )({}, {});
    expect(result).toEqual({ value: 99 });
  });
});
