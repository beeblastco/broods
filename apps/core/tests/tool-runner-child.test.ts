/**
 * Node-native sandbox runner (child-runner.mjs) tests.
 * Spawn the runner under real Node — no AWS, no native addons — and assert the
 * NDJSON frames for the execute contract it shares with the isolate runner:
 * object/factory exports, async-generator streaming, node: imports, the SDK
 * options surface, and the name/hash integrity guards.
 */

import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const childRunnerPath = fileURLToPath(
  new URL(
    "../src/harness/sandbox/tool-runner/child-runner.mjs",
    import.meta.url,
  ),
);

describe("sandbox child-runner", () => {
  it("runs a plain object export and returns the final result", async () => {
    const result = await runChild(
      "export default { name: 'echo', execute(input) { return { echo: input }; } };",
      { toolName: "echo", input: { message: "hi" } },
    );

    expect(result.frames).toEqual([
      { t: "final", result: { echo: { message: "hi" } } },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("calls a factory default export before reading execute", async () => {
    const result = await runChild(
      "export default () => ({ name: 'factory', execute: (input) => ({ got: input }) });",
      { toolName: "factory", input: { n: 1 } },
    );

    expect(result.frames).toEqual([{ t: "final", result: { got: { n: 1 } } }]);
  });

  it("streams async-generator yields as chunks and repeats the last as final", async () => {
    const result = await runChild(
      "export default { name: 'streamer', async *execute() { yield { step: 1 }; yield { step: 2 }; } };",
      { toolName: "streamer" },
    );

    expect(result.frames).toEqual([
      { t: "chunk", output: { step: 1 } },
      { t: "chunk", output: { step: 2 } },
      { t: "final", result: { step: 2 } },
    ]);
  });

  it("allows node: imports and native fetch (no network call)", async () => {
    const result = await runChild(
      `import { randomUUID } from 'node:crypto';
       export default { name: 'nodey', execute() {
         return { hasId: typeof randomUUID() === 'string', hasFetch: typeof fetch === 'function' };
       } };`,
      { toolName: "nodey" },
    );

    expect(result.frames).toEqual([
      { t: "final", result: { hasId: true, hasFetch: true } },
    ]);
  });

  it("passes SDK execution options (context, toolCallId, abortSignal)", async () => {
    const result = await runChild(
      `export default { name: 'opts', execute(input, options) {
         return {
           echo: input,
           cfg: options.context.config,
           callId: options.toolCallId,
           signalOk: options.abortSignal != null && options.abortSignal.aborted === false,
         };
       } };`,
      {
        toolName: "opts",
        input: { q: "hi" },
        config: { k: "v" },
        toolCallId: "call_123",
      },
    );

    expect(result.frames).toEqual([
      {
        t: "final",
        result: {
          echo: { q: "hi" },
          cfg: { k: "v" },
          callId: "call_123",
          signalOk: true,
        },
      },
    ]);
  });

  it("surfaces thrown tool errors", async () => {
    const result = await runChild(
      "export default { name: 'boom', execute() { throw new Error('boom'); } };",
      { toolName: "boom" },
    );

    expect(result.frames).toEqual([{ t: "error", error: "boom" }]);
    expect(result.exitCode).toBe(1);
  });

  it("rejects a name mismatch against the uploaded manifest", async () => {
    const result = await runChild(
      "export default { name: 'declared', execute() { return 1; } };",
      { toolName: "expected" },
    );

    expect(result.frames).toEqual([
      {
        t: "error",
        error: "custom tool bundle name does not match uploaded manifest",
      },
    ]);
  });

  it("rejects a bundle hash mismatch", async () => {
    const result = await runChild(
      "export default { name: 'bad', execute() { return 1; } };",
      { toolName: "bad", expectedSha256: "b".repeat(64) },
    );

    expect(result.frames).toEqual([
      {
        t: "error",
        error: "custom tool bundle hash mismatch inside sandbox runner",
      },
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("errors when the default export has no execute", async () => {
    const result = await runChild("export default { name: 'noexec' };", {
      toolName: "noexec",
    });

    expect(result.frames).toEqual([
      {
        t: "error",
        error:
          "custom tool bundle default export must expose execute(input, options)",
      },
    ]);
  });
});

async function runChild(
  source: string,
  options: {
    toolName: string;
    input?: unknown;
    config?: Record<string, unknown>;
    toolCallId?: string;
    expectedSha256?: string;
  },
): Promise<{ frames: unknown[]; exitCode: number | null }> {
  const expectedSha256 =
    options.expectedSha256 ??
    new Bun.CryptoHasher("sha256").update(source).digest("hex");
  const child = spawn("node", [childRunnerPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.resume();
  child.stdin.end(
    `${JSON.stringify({
      bundleSourceB64: Buffer.from(source).toString("base64"),
      expectedSha256,
      toolName: options.toolName,
      input: options.input ?? {},
      config: options.config ?? {},
      ...(options.toolCallId !== undefined
        ? { toolCallId: options.toolCallId }
        : {}),
    })}\n`,
  );
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });

  return {
    frames: stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    exitCode,
  };
}
