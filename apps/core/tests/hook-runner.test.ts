/**
 * Code hook tests: per-event mutation sanitization (always) and real isolate
 * hook-mode dispatch (when BROODS_TEST_ISOLATE_RUNNER_PATH points at a runner
 * whose directory has node_modules/isolated-vm installed).
 */

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { sanitizeHookResult, isHookMutableEvent } from "../src/harness/hook-runner.ts";

describe("sanitizeHookResult", () => {
  it("keeps only the mutable fields for the event", () => {
    expect(sanitizeHookResult("agent.started", { system: "Be terse.", messages: [{ role: "user" }], nope: 1 }))
      .toEqual({ system: "Be terse.", messages: [{ role: "user" }] });
    expect(sanitizeHookResult("tool.call.started", { decision: "deny", denyReason: "no", extra: true }))
      .toEqual({ decision: "deny", denyReason: "no" });
    expect(sanitizeHookResult("channel.message.sending", { drop: true, text: "edited", secret: "x" }))
      .toEqual({ drop: true, text: "edited" });
  });

  it("returns undefined for observe-only events", () => {
    expect(sanitizeHookResult("agent.step.finished", { anything: 1 })).toBeUndefined();
    expect(sanitizeHookResult("tool.call.finished", { output: 1 })).toBeUndefined();
    expect(isHookMutableEvent("agent.failed")).toBe(false);
    expect(isHookMutableEvent("tool.call.started")).toBe(true);
  });

  it("returns undefined when the return is not a plain object or has no mutable field", () => {
    expect(sanitizeHookResult("agent.started", null)).toBeUndefined();
    expect(sanitizeHookResult("agent.started", [1, 2])).toBeUndefined();
    expect(sanitizeHookResult("agent.started", "nope")).toBeUndefined();
    expect(sanitizeHookResult("agent.started", { unrelated: 1 })).toBeUndefined();
  });

  it("throws when the return exceeds the size cap", () => {
    const huge = { system: "x".repeat(200 * 1024) };
    expect(() => sanitizeHookResult("agent.started", huge)).toThrow(/exceeds/);
  });
});

const runnerPath = process.env.BROODS_TEST_ISOLATE_RUNNER_PATH;
const realRunnerIt = runnerPath ? it : it.skip;

describe("isolate runner hook mode", () => {
  // Hook mode returns { result, state }: the handler's value plus ctx.state read
  // back out. state is {} here since these handlers do not touch it.
  realRunnerIt("invokes the handler for the fired event and returns its value", async () => {
    const result = await runHookRunner(
      `export default {
        "agent.started": (ctx, event) => ({ system: event.system + " Be terse." }),
        "tool.call.started": (ctx, event) => ({ decision: "deny", denyReason: "blocked " + event.toolCall.toolName }),
      };`,
      "agent.started",
      { system: "Base." },
    );
    expect(result.frames).toEqual([{ t: "final", result: { result: { system: "Base. Be terse." }, state: {} } }]);
  });

  realRunnerIt("routes each event to its own handler", async () => {
    const source = `export default {
      "agent.started": () => ({ system: "started" }),
      "tool.call.started": (ctx, event) => ({ decision: event.toolCall.toolName === "bash" ? "deny" : "allow" }),
    };`;
    const denied = await runHookRunner(source, "tool.call.started", { toolCall: { toolName: "bash" } });
    expect(denied.frames).toEqual([{ t: "final", result: { result: { decision: "deny" }, state: {} } }]);
    const allowed = await runHookRunner(source, "tool.call.started", { toolCall: { toolName: "read" } });
    expect(allowed.frames).toEqual([{ t: "final", result: { result: { decision: "allow" }, state: {} } }]);
  });

  realRunnerIt("exposes ctx.state and returns it after the hook mutates it", async () => {
    const result = await runHookRunner(
      `export default { "agent.started": (ctx) => { ctx.state.seen = (ctx.state.seen ?? 0) + 1; return { system: "s" }; } };`,
      "agent.started",
      { system: "Base." },
      { seen: 4 },
    );
    expect(result.frames).toEqual([{ t: "final", result: { result: { system: "s" }, state: { seen: 5 } } }]);
  });

  realRunnerIt("returns no mutation and unchanged state when the bundle has no handler for the event", async () => {
    const result = await runHookRunner(
      `export default { "agent.started": () => ({ system: "x" }) };`,
      "agent.finished",
      { output: "done" },
      { kept: true },
    );
    expect(result.frames).toEqual([{ t: "final", result: { state: { kept: true } } }]);
  });

  realRunnerIt("surfaces a thrown hook as an error frame", async () => {
    const result = await runHookRunner(
      `export default { "agent.started": () => { throw new Error("hook boom"); } };`,
      "agent.started",
      {},
    );
    expect(result.frames).toEqual([{ t: "error", error: "hook boom" }]);
    expect(result.exitCode).toBe(1);
  });
});

async function runHookRunner(
  source: string,
  hookEvent: string,
  payload: unknown,
  state: Record<string, unknown> = {},
): Promise<{ frames: unknown[]; exitCode: number | null; stderr: string }> {
  const child = spawn("node", [runnerPath!], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    bundleSourceB64: Buffer.from(source).toString("base64"),
    expectedSha256: createHash("sha256").update(source).digest("hex"),
    toolName: "test_hook",
    hookEvent,
    input: payload,
    config: {},
    state,
  }) + "\n");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  return {
    frames: stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)),
    exitCode,
    stderr,
  };
}
