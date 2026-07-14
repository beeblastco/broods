/**
 * End-to-end hook machinery test: a real uploaded bundle, loaded from S3 (mocked
 * transport), executed in a live isolated-vm, whose sanitized return actually (a)
 * injects a system prompt at agent.started and (b) denies a tool call through the
 * tool wrapper. Exercises hook-runner + isolate + hook-dispatcher together; only
 * the S3 byte fetch is stubbed. Runs when BROODS_TEST_ISOLATE_RUNNER_PATH is set.
 */

import { describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import * as realS3 from "../src/shared/s3.ts";
import type { AccountHookRecord } from "../src/shared/domain/account-hooks.ts";
import type { AgentHookEventName } from "../src/shared/domain/agent-config.ts";

const HOOK_BUNDLE = `export default {
  "agent.started": (ctx, event) => {
    ctx.state.calls = (ctx.state.calls ?? 0) + 1;
    return { system: event.system + "\\n\\n[injected by policy hook]" };
  },
  "agent.finished": (ctx, event) => ({ output: "calls=" + (ctx.state.calls ?? 0) }),
  "tool.call.started": (ctx, event) =>
    event.toolName === "bash"
      ? { decision: "deny", denyReason: "shell disabled by policy hook" }
      : { decision: "allow" },
  "subagent.task.finished": (ctx, event) => ({ visibleResult: "summary of " + event.taskId }),
  "channel.message.received": (ctx, event) =>
    event.text === "spam" ? { drop: true } : { text: event.text.toUpperCase() },
};`;

const bundleSha = createHash("sha256").update(HOOK_BUNDLE, "utf8").digest("hex");

const runnerPath = process.env.BROODS_TEST_ISOLATE_RUNNER_PATH;
// isolate-executor reads ISOLATE_RUNNER_PATH; point it at the test runner (whose
// dir has isolated-vm installed) so the in-core execution path uses it.
if (runnerPath) {
  process.env.ISOLATE_RUNNER_PATH = runnerPath;
  // Stub only the S3 byte fetch; everything else (isolate exec, sanitize, wrap)
  // is real. mock.module is process-global in bun test, so keep it behind the
  // runner gate — when the suite is skipped the override must not leak into
  // other test files that mock the same module.
  mock.module("../src/shared/s3.ts", () => ({
    ...realS3,
    readS3Bytes: async () => new TextEncoder().encode(HOOK_BUNDLE) as Uint8Array,
  }));
}
const realRunnerIt = runnerPath ? it : it.skip;

describe("code hooks end-to-end (real isolate)", () => {
  realRunnerIt("injects a system prompt from an agent.started hook", async () => {
    process.env.TOOL_BUNDLES_BUCKET_NAME = "test-bundles";
    const { createHookDispatcher } = await import("../src/harness/hook-dispatcher.ts");
    const dispatcher = createHookDispatcher("acct_test", indexFor(["agent.started", "tool.call.started"]));

    const mutation = await dispatcher.runMutation("agent.started", {
      system: "You are helpful.",
      messages: [],
    });

    expect(mutation).toEqual({ system: "You are helpful.\n\n[injected by policy hook]" });
  });

  realRunnerIt("denies a real tool call through the tool wrapper", async () => {
    process.env.TOOL_BUNDLES_BUCKET_NAME = "test-bundles";
    const { createHookDispatcher, wrapToolsWithHooks } = await import("../src/harness/hook-dispatcher.ts");
    const dispatcher = createHookDispatcher("acct_test", indexFor(["agent.started", "tool.call.started"]));

    let bashRan = false;
    let readRan = false;
    const tools: ToolSet = {
      bash: fakeTool(() => { bashRan = true; return "ran"; }),
      read: fakeTool(() => { readRan = true; return "file contents"; }),
    };
    const wrapped = wrapToolsWithHooks(tools, dispatcher);

    await expect((wrapped.bash!.execute as (i: unknown, o: unknown) => Promise<unknown>)({ command: "ls" }, {}))
      .rejects.toThrow(/shell disabled by policy hook/);
    expect(bashRan).toBe(false); // denied before execution

    const allowed = await (wrapped.read!.execute as (i: unknown, o: unknown) => Promise<unknown>)({ path: "a.txt" }, {});
    expect(readRan).toBe(true);
    expect(allowed).toBe("file contents");
  });

  realRunnerIt("threads ctx.state across hooks in one run", async () => {
    process.env.TOOL_BUNDLES_BUCKET_NAME = "test-bundles";
    const { createHookDispatcher } = await import("../src/harness/hook-dispatcher.ts");
    const dispatcher = createHookDispatcher("acct_test", indexFor(["agent.started", "agent.finished"]));

    // First hook seeds ctx.state.calls; the second reads what it left behind.
    await dispatcher.runMutation("agent.started", { system: "You are helpful.", messages: [] });
    const finished = await dispatcher.runMutation("agent.finished", { finishReason: "stop", response: "hi" });

    expect(finished).toEqual({ output: "calls=1" });
  });

  realRunnerIt("serializes overlapping hook runs so concurrent ctx.state writes are not lost", async () => {
    process.env.TOOL_BUNDLES_BUCKET_NAME = "test-bundles";
    const { createHookDispatcher } = await import("../src/harness/hook-dispatcher.ts");
    const dispatcher = createHookDispatcher("acct_test", indexFor(["agent.started", "agent.finished"]));

    // Parallel tool calls / subagent finishes can enter runMutation concurrently;
    // both increments must land instead of the last writer clobbering the first.
    await Promise.all([
      dispatcher.runMutation("agent.started", { system: "a", messages: [] }),
      dispatcher.runMutation("agent.started", { system: "b", messages: [] }),
    ]);
    const finished = await dispatcher.runMutation("agent.finished", { finishReason: "stop", response: "hi" });

    expect(finished).toEqual({ output: "calls=2" });
  });

  realRunnerIt("shapes subagent visibility and drops/rewrites channel messages", async () => {
    process.env.TOOL_BUNDLES_BUCKET_NAME = "test-bundles";
    const { createHookDispatcher } = await import("../src/harness/hook-dispatcher.ts");
    const dispatcher = createHookDispatcher("acct_test", indexFor(["subagent.task.finished", "channel.message.received"]));

    expect(await dispatcher.runMutation("subagent.task.finished", { taskId: "t1", result: "long output" }))
      .toEqual({ visibleResult: "summary of t1" });
    expect(await dispatcher.runMutation("channel.message.received", { channel: "telegram", text: "spam" }))
      .toEqual({ drop: true });
    expect(await dispatcher.runMutation("channel.message.received", { channel: "telegram", text: "hi" }))
      .toEqual({ text: "HI" });
  });
});

function fakeTool(execute: () => unknown): ToolSet[string] {
  return { execute: async () => execute() } as unknown as ToolSet[string];
}

function indexFor(events: AgentHookEventName[]): Map<AgentHookEventName, AccountHookRecord[]> {
  const record: AccountHookRecord = {
    accountId: "acct_test",
    hookId: "hook_demo",
    name: "policy_hook",
    events,
    bundleStorageKey: "account-hooks/acct_test/bundles/x.mjs",
    sha256: bundleSha,
    status: "active",
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  };
  return new Map(events.map((event) => [event, [record]]));
}
