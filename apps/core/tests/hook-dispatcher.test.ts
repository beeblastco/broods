// The dispatcher is a local fake; hooks-integration.test.ts runs real isolates.

import { describe, expect, it } from "bun:test";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
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
    runMutation: async function (event, payload) {
      return responder(event, payload as Record<string, unknown>);
    },
  };
}

describe("wrapToolsWithHooks", () => {
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

  it("shows a stand-in call as the Broods call it runs as", async () => {
    let seen: Record<string, unknown> | undefined;
    const tools: ToolSet = { shell: fakeTool(() => "ran") };
    const shellAsBash = new Map([
      [
        "shell",
        {
          toSandboxCall: () => ({
            toolName: "bash" as const,
            input: { command: "rm -rf x" },
          }),
          execute: async () => "ran",
          replaces: ["bash" as const],
          runsAs: ["bash" as const],
        },
      ],
    ]);
    const wrapped = wrapToolsWithHooks(
      tools,
      dispatcherReturning((event, payload) => {
        if (event === "tool.call.started") seen = payload;
        return undefined;
      }),
      shellAsBash,
    );
    await (
      wrapped.shell!.execute as (i: unknown, o: unknown) => Promise<unknown>
    )({ action: { commands: ["rm -rf x"] } }, {});
    expect(seen).toEqual({
      toolName: "shell",
      input: { action: { commands: ["rm -rf x"] } },
      runsAs: { toolName: "bash", input: { command: "rm -rf x" } },
    });
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

  // The SDK validates args before execute and never sees a hook's replacement.
  it("refuses edited args the tool's input schema rejects", async () => {
    let ran = false;
    const tools: ToolSet = {
      search: tool({
        inputSchema: z.strictObject({ query: z.string().min(1) }),
        execute: async (): Promise<string> => {
          ran = true;

          return "ok";
        },
      }),
    };
    const editTo = (args: unknown): ToolSet =>
      wrapToolsWithHooks(
        tools,
        dispatcherReturning((event) =>
          event === "tool.call.started"
            ? { decision: "allow", args: args }
            : undefined,
        ),
      );
    const run = (wrapped: ToolSet): Promise<unknown> =>
      (wrapped.search!.execute as (i: unknown, o: unknown) => Promise<unknown>)(
        { query: "original" },
        {},
      );

    await expect(run(editTo({ query: "" }))).rejects.toThrow(
      /invalid args from hook/,
    );
    await expect(run(editTo({ query: "x", extra: 1 }))).rejects.toThrow(
      /invalid args from hook/,
    );
    expect(ran).toBe(false);
    expect(await run(editTo({ query: "edited" }))).toBe("ok");
  });

  it("ignores edited args that are not an object", async () => {
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
          ? { decision: "allow", args: null }
          : undefined,
      ),
    );
    await (
      wrapped.search!.execute as (i: unknown, o: unknown) => Promise<unknown>
    )({ query: "original" }, {});

    expect(seen).toEqual({ query: "original" });
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
