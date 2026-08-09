/**
 * Node-native runner for sandbox-tier account tools. Unlike the isolate runner
 * (harness/isolate/runner/runner.mjs) this runs the uploaded bundle in a real
 * Node process — full fetch/timers/AbortController, node: builtins, and any npm
 * deps the bundler inlined — so AI-SDK ecosystem tools work. It is spawned per
 * invocation by handler.mjs with a scrubbed env and speaks the same NDJSON frame
 * protocol (chunk/final/error) the core invoker already parses. The run request
 * arrives on stdin; the bundle arrives as raw bytes on fd 3.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The bundle rides its own pipe rather than base64 inside the request JSON:
// encoding a 7 MB bundle costs a third more bytes and ~25ms of CPU on both
// sides of the pipe, for nothing.
const BUNDLE_FD = 3;

// Wall-clock deadline for the whole run; the handler also hard-kills the child,
// this is the cooperative in-process bound that trips ctx.abortSignal first.
const DEFAULT_TIMEOUT_SECONDS = 30;

// The identity the bundle is imported under. Nothing is ever written here — the
// loader hook answers it from memory — but it has to be a file URL: bundlers
// emit `createRequire(import.meta.url)`, which rejects a data: URL outright and
// throws before a line of the tool's own code runs.
const BUNDLE_URL = pathToFileURL(
  join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), "broods-tool-bundle.mjs"),
).href;

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
    // Both pipes at once: the handler writes the request immediately and the
    // bundle whenever its S3 fetch lands, so neither should gate the other.
    const [request, bundle] = await Promise.all([
      readAllStdin(),
      readBundleBytes(),
    ]);
    const payload = parsePayload(JSON.parse(request));
    const result = await runBundle(payload, bundle, controller.signal);
    clearTimeout(timeout);
    emitTerminal({ t: "final", result: result }, 0);
  } catch (error) {
    clearTimeout(timeout);
    emitTerminal({ t: "error", error: errorMessage(error) }, 1);
  }
}

// Loads the bundle, resolves execute(input, options), and returns its result.
// A sync async-generator return streams each yield as a chunk frame; a plain
// return resolves once. Mirrors the isolate runner's execute contract.
async function runBundle(payload, bundle, abortSignal) {
  const actualSha = createHash("sha256").update(bundle).digest("hex");
  if (actualSha !== payload.expectedSha256) {
    throw new Error("custom tool bundle hash mismatch inside sandbox runner");
  }

  const module = await importBundle(bundle);

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

  // The AI SDK's own execute options, so an uploaded bundle sees what the same
  // tool would see in-process. Core bounds messages before it sends them.
  const options = {
    toolCallId: payload.toolCallId,
    context: {
      config: payload.config,
      fetch: globalThis.fetch,
      state: {},
    },
    abortSignal: abortSignal,
    messages: payload.messages ?? [],
    experimental_context: payload.experimentalContext ?? undefined,
  };
  const value = definition.execute(payload.input, options);
  if (value != null && typeof value[Symbol.asyncIterator] === "function") {
    let last;
    for await (const output of value) {
      // User code may ignore abortSignal; stop writing so no chunk lands after
      // the timeout's terminal frame.
      if (abortSignal.aborted) break;
      last = output;
      writeFrame({ t: "chunk", output: output });
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

async function readBundleBytes() {
  const chunks = [];
  for await (const chunk of createReadStream(null, { fd: BUNDLE_FD })) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

// Served straight out of memory through a resolve/load hook, never written to
// disk: /tmp survives in a warm Lambda sandbox, so a bundle on disk is readable
// by any process that outlives its run. The hook takes the bytes as-is, so the
// bundle is never decoded to a string on the way in.
async function importBundle(source) {
  registerHooks({
    load: (url, context, next) =>
      url === BUNDLE_URL
        ? { format: "module", source: source, shortCircuit: true }
        : next(url, context),
    resolve: (specifier, context, next) =>
      specifier === BUNDLE_URL
        ? { url: BUNDLE_URL, format: "module", shortCircuit: true }
        : next(specifier, context),
  });

  return await import(BUNDLE_URL);
}

// The terminal frame carries this run's CPU. The child is one process per tool
// call, so its own cpuUsage is exactly what the call cost, S3 fetch and parse in.
function emitTerminal(frame, code) {
  if (settled) return;
  settled = true;
  const cpu = process.cpuUsage();
  const stamped = { ...frame, cpuUsec: cpu.user + cpu.system };
  // Flush the terminal frame before exiting so a pipe write is never truncated,
  // and force-exit so user code's lingering handles cannot keep the child alive.
  process.stdout.write(`${JSON.stringify(stamped)}\n`, () =>
    process.exit(code),
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid sandbox runner payload");
  }
  if (typeof payload.expectedSha256 !== "string") {
    throw new Error("sandbox runner payload missing expectedSha256");
  }
  if (typeof payload.toolName !== "string") {
    throw new Error("sandbox runner payload missing toolName");
  }

  return {
    expectedSha256: payload.expectedSha256,
    toolName: payload.toolName,
    input: payload.input,
    config:
      payload.config && typeof payload.config === "object"
        ? payload.config
        : {},
    toolCallId:
      typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    experimentalContext: payload.experimentalContext,
  };
}

function runTimeoutMs() {
  const value = Number(process.env.TOOL_RUNNER_TIMEOUT_SECONDS);
  const seconds =
    Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_SECONDS;

  return seconds * 1000;
}

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
