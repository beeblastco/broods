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

describe("channel.message.received rewrite reaches the session", () => {
  // Full wiring: webhook → processChannelMessage → real hook in a live isolate
  // → handleChannelRequest. The regression this pins: the rewrite landed only
  // in `content` while the session reads `events`, so it never reached the
  // model despite every unit underneath passing.
  realRunnerIt("forwards the rewritten ingress events to the channel handler", async () => {
    process.env.TOOL_BUNDLES_BUCKET_NAME = "test-bundles";
    const { createIncomingEventRouter } = await import("../src/harness/integrations.ts");
    const { setStorageForTests, resetStorageForTests } = await import("../src/shared/storage.ts");
    const { coreRequest } = await import("./helpers/http.ts");

    const hookRecord = indexFor(["channel.message.received"]).get("channel.message.received")![0]!;
    setStorageForTests({
      accountHooks: { getById: async () => hookRecord },
    } as unknown as Parameters<typeof setStorageForTests>[0]);

    const channels = {
      telegram: { botToken: "bot-token", webhookSecret: "telegram-secret", allowedChatIds: [123] },
    };
    const handled: Array<{ content: unknown; events: unknown }> = [];
    try {
      const waited: Promise<unknown>[] = [];
      const route = createIncomingEventRouter({
        accountLoader: async () => ({
          accountId: "acct_test",
          username: "test-account",
          secretHash: "hash",
          status: "active" as const,
          config: { channels },
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
        }),
        agentLoader: async () => ({
          accountId: "acct_test",
          agentId: "agent_test",
          name: "Hooked agent",
          status: "active" as const,
          config: {
            channels,
            hooks: { code: [{ hookId: hookRecord.hookId, enabled: true }] },
          },
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
        }),
        deploymentLoader: async () => null,
        waitUntil: (promise) => waited.push(Promise.resolve(promise)),
      });

      await route(
        coreRequest(
          "POST",
          "/webhooks/acct_test/agent_test/telegram",
          { "x-telegram-bot-api-secret-token": "telegram-secret" },
          {
            update_id: 7,
            message: {
              message_id: 9,
              date: 1713916800,
              text: "hello",
              chat: { id: 123, type: "private" },
              from: { id: 456, is_bot: false, username: "alice" },
            },
          },
        ),
        {
          handleDirectRequest: async () => new Response("ok"),
          handleChannelRequest: async (event: { content: unknown; events: unknown }) => {
            handled.push({ content: event.content, events: event.events });
          },
        },
      );
      await Promise.all(waited);
    } finally {
      resetStorageForTests();
    }

    // The test bundle uppercases the text; both the content AND the ingress
    // events the session persists must carry the rewrite.
    expect(handled).toHaveLength(1);
    expect(handled[0]!.content).toBe("HELLO");
    expect(handled[0]!.events).toEqual([{ role: "user", content: "HELLO" }]);
  });

  // The session persists and builds the turn from the ingress events, not from
  // `content` — a rewrite that only lands in `content` never reaches the model.
  it("rewrites the newest user ingress event", async () => {
    const { rewriteLatestUserIngressText } = await import("../src/harness/integrations.ts");

    const rewritten = rewriteLatestUserIngressText(
      [
        { role: "system" as const, content: "channel joined" },
        { role: "user" as const, content: "hello" },
      ],
      "[channel-context slack:C1 sender:U1] hello",
    );

    expect(rewritten).toEqual([
      { role: "system", content: "channel joined" },
      { role: "user", content: "[channel-context slack:C1 sender:U1] hello" },
    ]);
  });

  it("leaves events untouched when none are user messages", async () => {
    const { rewriteLatestUserIngressText } = await import("../src/harness/integrations.ts");
    const events = [{ role: "system" as const, content: "context only" }];

    expect(rewriteLatestUserIngressText(events, "rewritten")).toEqual(events);
  });
});

function fakeTool(execute: () => unknown): ToolSet[string] {
  return { execute: async () => execute() } as unknown as ToolSet[string];
}

function indexFor(events: AgentHookEventName[]): Map<AgentHookEventName, AccountHookRecord[]> {
  const record: AccountHookRecord = {
    accountId: "acct_test",
    hookId: "k17zwc4z4q5ysxm74fgrhd13s88xxtv",
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
