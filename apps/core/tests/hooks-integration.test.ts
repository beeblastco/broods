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
import type { AccountHookRecord } from "../src/shared/storage/account-hooks.ts";
import type { AgentHookEventName } from "../src/shared/storage/agent-config.ts";

const HOOK_BUNDLE = `export default {
  "agent.started": (ctx, event) => ({ system: event.system + "\\n\\n[injected by policy hook]" }),
  "tool.call.started": (ctx, event) =>
    event.toolName === "bash"
      ? { decision: "deny", denyReason: "shell disabled by policy hook" }
      : { decision: "allow" },
};`;

const bundleSha = createHash("sha256").update(HOOK_BUNDLE, "utf8").digest("hex");

// Stub only the S3 byte fetch; everything else (isolate exec, sanitize, wrap) is real.
mock.module("../src/shared/s3.ts", () => ({
  ...realS3,
  readS3Bytes: async () => new TextEncoder().encode(HOOK_BUNDLE) as Uint8Array,
}));

const runnerPath = process.env.BROODS_TEST_ISOLATE_RUNNER_PATH;
// isolate-executor reads ISOLATE_RUNNER_PATH; point it at the test runner (whose
// dir has isolated-vm installed) so the in-core execution path uses it.
if (runnerPath) {
  process.env.ISOLATE_RUNNER_PATH = runnerPath;
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
