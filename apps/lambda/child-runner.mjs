/**
 * Node-native runner for sandbox-tier account tools. Unlike the isolate runner
 * (harness/isolate/runner/runner.mjs) this runs the uploaded bundle in a real
 * Node process — full fetch/timers/AbortController, node: builtins, and any npm
 * deps the bundler inlined — so AI-SDK ecosystem tools work. It is spawned per
 * invocation by handler.mjs with a scrubbed env and speaks the same NDJSON frame
 * protocol (chunk/final/error) the core invoker already parses.
 */

import { createHash } from "node:crypto";

// Wall-clock deadline for the whole run; the handler also hard-kills the child,
// this is the cooperative in-process bound that trips ctx.abortSignal first.
const DEFAULT_TIMEOUT_SECONDS = 30;

// The timeout and the run's own completion race: process.exit is deferred to the
// stdout flush callback, so without this the aborted run emits a second terminal
// frame after the timeout already wrote one.
let settled = false;

// Stray timers/promises in user code must not crash the runner after the
// terminal frame is on stdout; still log to stderr so real bugs stay visible.
process.on("unhandledRejection", (reason) => {
  console.error("[tool-runner] unhandled rejection:", reason);
});

await runToolRequest();

async function runToolRequest() {
  const controller = new AbortController();
  const timeoutMs = runTimeoutMs();
  const timeout = setTimeout(() => {
    controller.abort(new Error("custom tool sandbox execution timed out"));
    emitTerminal(
      { t: "error", error: "custom tool sandbox execution timed out" },
      1,
    );
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
async function runBundle(payload, abortSignal) {
  const bundleSourceB64 = await readBundleSource(payload);
  const actualSha = createHash("sha256")
    .update(Buffer.from(bundleSourceB64, "base64"))
    .digest("hex");
  if (actualSha !== payload.expectedSha256) {
    throw new Error("custom tool bundle hash mismatch inside sandbox runner");
  }

  // Imported from memory, never written to disk: /tmp survives in a warm Lambda
  // sandbox, so a bundle on disk is readable by any process that outlives its run.
  const module = await import(`data:text/javascript;base64,${bundleSourceB64}`);

  let definition = module.default;
  if (typeof definition === "function") {
    definition = await definition();
  }
  if (!definition || typeof definition.execute !== "function") {
    throw new Error(
      "custom tool bundle default export must expose execute(input, options)",
    );
  }
  if (definition.name && definition.name !== payload.toolName) {
    throw new Error("custom tool bundle name does not match uploaded manifest");
  }

  const options = {
    toolCallId: payload.toolCallId,
    context: {
      config: payload.config,
      asyncTool: null,
      env: {},
      fetch: globalThis.fetch,
      state: {},
    },
    abortSignal,
  };
  const value = definition.execute(payload.input, options);
  if (value != null && typeof value[Symbol.asyncIterator] === "function") {
    let last;
    for await (const output of value) {
      // User code may ignore abortSignal; stop writing so no chunk lands after
      // the timeout's terminal frame.
      if (abortSignal.aborted) break;
      last = output;
      writeFrame({ t: "chunk", output });
    }
    return last;
  }
  return await value;
}

async function readAllStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input.trim();
}

async function readBundleSource(payload) {
  if (payload.bundleSourceB64 !== undefined) return payload.bundleSourceB64;
  const response = await fetch(payload.bundleUrl);
  if (!response.ok) {
    throw new Error(
      `custom tool bundle fetch failed with HTTP ${response.status}`,
    );
  }

  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

function emitTerminal(frame, code) {
  if (settled) return;
  settled = true;
  // Flush the terminal frame before exiting so a pipe write is never truncated,
  // and force-exit so user code's lingering handles cannot keep the child alive.
  process.stdout.write(`${JSON.stringify(frame)}\n`, () => process.exit(code));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid sandbox runner payload");
  }
  const hasSource = typeof payload.bundleSourceB64 === "string";
  const hasUrl = typeof payload.bundleUrl === "string";
  if (hasSource === hasUrl) {
    throw new Error(
      "sandbox runner payload needs exactly one of bundleSourceB64 or bundleUrl",
    );
  }
  if (typeof payload.expectedSha256 !== "string") {
    throw new Error("sandbox runner payload missing expectedSha256");
  }
  if (typeof payload.toolName !== "string") {
    throw new Error("sandbox runner payload missing toolName");
  }
  return {
    bundleSourceB64: hasSource ? payload.bundleSourceB64 : undefined,
    bundleUrl: hasUrl ? payload.bundleUrl : undefined,
    expectedSha256: payload.expectedSha256,
    toolName: payload.toolName,
    input: payload.input,
    config:
      payload.config && typeof payload.config === "object"
        ? payload.config
        : {},
    toolCallId:
      typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
  };
}

// Inline bytes or a presigned GET, which keeps the bundle out of the 6 MB invoke
// quota. Fetched before tenant code runs; the sha256 check is what makes it safe.

function runTimeoutMs() {
  const value = Number(process.env.TOOL_RUNNER_TIMEOUT_SECONDS);
  const seconds =
    Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_SECONDS;
  return seconds * 1000;
}

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
