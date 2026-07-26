/**
 * Node-native runner for sandbox-tier account tools. Runs the uploaded bundle in
 * a real Node process — full fetch/timers/AbortController, node: builtins, and
 * any npm deps the bundler inlined — so AI-SDK ecosystem tools work. Spawned per
 * invocation by handler.ts with a scrubbed env, and speaks the NDJSON frame
 * protocol (chunk/final/error) that core's custom-tools/payload.ts parses.
 */

import { createHash } from "node:crypto";

interface RunnerPayload {
  bundleSourceB64: string;
  expectedSha256: string;
  toolName: string;
  input?: unknown;
  config: Record<string, unknown>;
  toolCallId?: string;
}

interface ToolDefinition {
  name?: string;
  execute: (input: unknown, options: ExecuteOptions) => unknown;
}

interface ExecuteOptions {
  toolCallId: string | undefined;
  context: Record<string, unknown>;
  abortSignal: AbortSignal;
}

type Frame =
  | { t: "chunk"; output: unknown }
  | { t: "final"; result: unknown }
  | { t: "error"; error: string };

// Wall-clock deadline for the whole run; the handler also hard-kills the child,
// this is the cooperative in-process bound that trips ctx.abortSignal first.
const DEFAULT_TIMEOUT_SECONDS = 30;

// Stray timers/promises in user code must not crash the runner after the
// terminal frame is on stdout; still log to stderr so real bugs stay visible.
process.on("unhandledRejection", (reason) => {
  console.error("[tool-runner] unhandled rejection:", reason);
});

await runToolRequest();

async function runToolRequest(): Promise<void> {
  const controller = new AbortController();
  const timeoutMs = runTimeoutMs();
  const timeout = setTimeout(() => {
    controller.abort(new Error("custom tool sandbox execution timed out"));
    emitTerminal({ t: "error", error: "custom tool sandbox execution timed out" }, 1);
  }, timeoutMs);
  try {
    const payload = parsePayload(JSON.parse(await readAllStdin()));
    const result = await runBundle(payload, controller.signal);
    clearTimeout(timeout);
    emitTerminal({ t: "final", result }, 0);
  } catch (error) {
    clearTimeout(timeout);
    emitTerminal({ t: "error", error: errorMessage(error) }, 1);
  }
}

// Loads the bundle, resolves execute(input, options), and returns its result.
// A sync async-generator return streams each yield as a chunk frame; a plain
// return resolves once. Mirrors the isolate runner's execute contract.
async function runBundle(
  payload: RunnerPayload,
  abortSignal: AbortSignal,
): Promise<unknown> {
  const bundleSource = Buffer.from(payload.bundleSourceB64, "base64");
  const actualSha = createHash("sha256").update(bundleSource).digest("hex");
  if (actualSha !== payload.expectedSha256) {
    throw new Error("custom tool bundle hash mismatch inside sandbox runner");
  }

  // Imported from memory, never written to disk: /tmp survives in a warm Lambda
  // sandbox, so a bundle on disk is readable by any process that outlives its run.
  const module = await import(
    `data:text/javascript;base64,${payload.bundleSourceB64}`
  );

  const exported = (module as { default?: unknown }).default;
  const definition = (
    typeof exported === "function" ? await exported() : exported
  ) as ToolDefinition | undefined;
  if (!definition || typeof definition.execute !== "function") {
    throw new Error(
      "custom tool bundle default export must expose execute(input, options)",
    );
  }
  if (definition.name && definition.name !== payload.toolName) {
    throw new Error("custom tool bundle name does not match uploaded manifest");
  }

  const options: ExecuteOptions = {
    toolCallId: payload.toolCallId,
    context: {
      config: payload.config,
      asyncTool: null,
      env: {},
      fetch: globalThis.fetch,
      state: {},
    },
    abortSignal: abortSignal,
  };
  const value = definition.execute(payload.input, options);
  if (isAsyncIterable(value)) {
    let last: unknown;
    for await (const output of value) {
      last = output;
      writeFrame({ t: "chunk", output: output });
    }

    return last;
  }

  return await value;
}

function emitTerminal(frame: Frame, code: number): void {
  // Flush the terminal frame before exiting so a pipe write is never truncated,
  // and force-exit so user code's lingering handles cannot keep the child alive.
  process.stdout.write(`${JSON.stringify(frame)}\n`, () => process.exit(code));
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePayload(raw: unknown): RunnerPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid sandbox runner payload");
  }
  const payload = raw as Record<string, unknown>;
  if (typeof payload.bundleSourceB64 !== "string") {
    throw new Error("sandbox runner payload missing bundleSourceB64");
  }
  if (typeof payload.expectedSha256 !== "string") {
    throw new Error("sandbox runner payload missing expectedSha256");
  }
  if (typeof payload.toolName !== "string") {
    throw new Error("sandbox runner payload missing toolName");
  }
  return {
    bundleSourceB64: payload.bundleSourceB64,
    expectedSha256: payload.expectedSha256,
    toolName: payload.toolName,
    input: payload.input,
    config:
      payload.config && typeof payload.config === "object"
        ? (payload.config as Record<string, unknown>)
        : {},
    toolCallId:
      typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
  };
}

async function readAllStdin(): Promise<string> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input.trim();
}

function runTimeoutMs(): number {
  const value = Number(process.env.TOOL_RUNNER_TIMEOUT_SECONDS);
  const seconds = Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_SECONDS;
  return seconds * 1000;
}

function writeFrame(frame: Frame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
