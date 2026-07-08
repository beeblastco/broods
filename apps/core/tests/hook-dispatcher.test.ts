/**
 * Hook dispatch wiring tests: the tool-execute wrapper (deny / edit args /
 * transform output) and the per-run dispatcher's multi-hook merge. Isolate
 * execution itself is covered in hook-runner.test.ts; here runCodeHook is mocked.
 */

import { describe, expect, it, mock } from "bun:test";
import type { ToolSet } from "ai";
import type { AccountHookRecord } from "../src/shared/storage/account-hooks.ts";
import type { AgentHookEventName } from "../src/shared/storage/agent-config.ts";
import type { HookDispatcher } from "../src/harness/hook-dispatcher.ts";
import { wrapToolsWithHooks } from "../src/harness/hook-dispatcher.ts";

function fakeTool(execute: (input: unknown) => unknown): ToolSet[string] {
  return { execute: async (input: unknown) => execute(input) } as unknown as ToolSet[string];
}

function dispatcherReturning(
  responder: (event: AgentHookEventName, payload: Record<string, unknown>) => Record<string, unknown> | undefined,
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
    const wrapped = wrapToolsWithHooks(tools, dispatcherReturning(() => undefined, []));
    expect(wrapped).toBe(tools);
  });

  it("denies a tool call when the hook returns decision: deny", async () => {
    const tools: ToolSet = { bash: fakeTool(() => "ran") };
    const wrapped = wrapToolsWithHooks(tools, dispatcherReturning((event) =>
      event === "tool.call.started" ? { decision: "deny", denyReason: "no shell" } : undefined,
    ));
    await expect((wrapped.bash.execute as (i: unknown, o: unknown) => Promise<unknown>)({ cmd: "ls" }, {}))
      .rejects.toThrow(/blocked by hook: no shell/);
  });

  it("edits tool args before execution", async () => {
    let seen: unknown;
    const tools: ToolSet = { search: fakeTool((input) => { seen = input; return "ok"; }) };
    const wrapped = wrapToolsWithHooks(tools, dispatcherReturning((event) =>
      event === "tool.call.started" ? { decision: "allow", args: { query: "edited" } } : undefined,
    ));
    const result = await (wrapped.search.execute as (i: unknown, o: unknown) => Promise<unknown>)({ query: "original" }, {});
    expect(seen).toEqual({ query: "edited" });
    expect(result).toBe("ok");
  });

  it("transforms tool output via a tool.result hook", async () => {
    const tools: ToolSet = { calc: fakeTool(() => ({ value: 1 })) };
    const wrapped = wrapToolsWithHooks(tools, dispatcherReturning((event) =>
      event === "tool.result" ? { output: { value: 99 } } : { decision: "allow" },
    ));
    const result = await (wrapped.calc.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {});
    expect(result).toEqual({ value: 99 });
  });
});

describe("createHookDispatcher", () => {
  it("runs every registered hook for an event and merges their mutations", async () => {
    const runCodeHook = mock(async ({ record }: { record: AccountHookRecord }) =>
      record.hookId === "hook_1" ? { system: "from-1", messages: ["a"] } : { system: "from-2" },
    );
    mock.module("../src/harness/hook-runner.ts", () => ({ runCodeHook }));
    const { createHookDispatcher } = await import("../src/harness/hook-dispatcher.ts");

    const index = new Map<AgentHookEventName, AccountHookRecord[]>([
      ["agent.started", [hookRecord("hook_1"), hookRecord("hook_2")]],
    ]);
    const dispatcher = createHookDispatcher("acct_test", index);

    expect(dispatcher.hasHooksFor("agent.started")).toBe(true);
    expect(dispatcher.hasHooksFor("tool.result")).toBe(false);
    // hook_2 runs after hook_1, so its `system` wins; hook_1's `messages` remains.
    expect(await dispatcher.runMutation("agent.started", {})).toEqual({ system: "from-2", messages: ["a"] });
    expect(runCodeHook).toHaveBeenCalledTimes(2);
  });
});

function hookRecord(hookId: string): AccountHookRecord {
  return {
    accountId: "acct_test",
    hookId,
    name: hookId,
    events: ["agent.started"],
    bundleStorageKey: `account-hooks/acct_test/bundles/${hookId}.mjs`,
    sha256: "a".repeat(64),
    status: "active",
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
}
