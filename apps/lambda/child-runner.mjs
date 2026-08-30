/**
 * Node-native runner for hosted MCP server bundles (#331, warm reuse #189).
 * Runs the uploaded bundle in a real Node process — full fetch/timers/
 * AbortController, node: builtins, and any npm deps the bundler inlined. The
 * bundle arrives as raw bytes on fd 3 once at spawn; requests then arrive as
 * NDJSON lines on stdin, one per Lambda invocation, and each is answered with
 * one terminal frame (final/error) on stdout. A `final` frame keeps the
 * process alive for the next same-tenant request; any error, timeout, or
 * unhandled rejection retires it by exiting, so a poisoned child never serves
 * another call.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// The bundle rides its own pipe rather than base64 inside the request JSON:
// encoding a 7 MB bundle costs a third more bytes and ~25ms of CPU on both
// sides of the pipe, for nothing.
const BUNDLE_FD = 3;

// Wall-clock deadline for one request; the handler also hard-kills the child,
// this is the cooperative in-process bound that trips the request signal first.
const DEFAULT_TIMEOUT_SECONDS = 30;

// The identity the bundle is imported under. Nothing is ever written here — the
// loader hook answers it from memory — but it has to be a file URL: bundlers
// emit `createRequire(import.meta.url)`, which rejects a data: URL outright and
// throws before a line of the server's own code runs.
const BUNDLE_URL = pathToFileURL(
  join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), "broods-mcp-bundle.mjs"),
).href;

// The request in flight and the timeout race to write the terminal frame; the
// first one wins and the loser is dropped, so a timed-out run never emits a
// second frame after the abort already wrote one. `true` also means idle —
// nothing is in flight before the first request or between requests.
let settled = true;

// User code that leaves a rejected promise behind must not crash the runner
// mid-frame, but it also must not serve another call. Mid-request, the child
// retires as soon as the current frame is flushed; idle — a stray timer
// rejecting between requests — it exits on the spot, so the next request can
// never run inside the poisoned process. `"exiting"` is left alone: an exit
// is already pending on that frame's flush.
let poisoned = false;
process.on("unhandledRejection", (reason) => {
  console.error("[mcp-runner] unhandled rejection:", reason);
  poisoned = true;
  if (settled === true) process.exit(1);
});

await runRequestLoop();

async function runRequestLoop() {
  const bundle = await readBundleBytes();
  const actualSha = createHash("sha256").update(bundle).digest("hex");
  let handlerModule;
  // One request per line; the handler serializes invocations, so by the time a
  // line arrives the previous request has already emitted its terminal frame.
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    settled = false;
    const cpuBaseline = process.cpuUsage();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("mcp server run timed out"));
      emitTerminal(
        { t: "error", error: "mcp server run timed out" },
        cpuBaseline,
        1,
      );
    }, runTimeoutMs());
    try {
      const payload = parsePayload(JSON.parse(line));
      if (payload.expectedSha256 !== actualSha) {
        throw new Error("bundle hash mismatch inside mcp runner");
      }
      // The per-request scratch dir replaces the spawn-time one so nothing a
      // call writes to HOME/TMPDIR is visible to the next call. Module-level
      // state the bundle itself hoists is the documented reuse trade-off.
      if (payload.home !== undefined) {
        process.env.HOME = payload.home;
        process.env.TMPDIR = payload.home;
      }
      handlerModule ??= await importBundle(bundle);
      const result = await runMcpBundle(
        handlerModule,
        payload,
        controller.signal,
      );
      clearTimeout(timeout);
      emitTerminal(
        { t: "final", result: result },
        cpuBaseline,
        poisoned ? 1 : null,
      );
    } catch (error) {
      clearTimeout(timeout);
      emitTerminal({ t: "error", error: errorMessage(error) }, cpuBaseline, 1);
    }
    // A timed-out run has its frame on the wire and its exit pending in the
    // flush callback; reading another line would race the exit.
    if (settled === "exiting") return;
  }
  process.exit(0);
}

// The bundle default-exports a fetch-style MCP handler (e.g.
// `createMcpHandler(...)` from @modelcontextprotocol/server). One request
// carries exactly one web request; the stateless 2026-07-28 transport is what
// makes that mapping complete.
async function runMcpBundle(module, payload, abortSignal) {
  const handler = module.default;
  const fetchLike =
    handler && typeof handler.fetch === "function"
      ? handler.fetch.bind(handler)
      : typeof handler === "function"
        ? handler
        : null;
  if (!fetchLike) {
    throw new Error(
      "mcp server bundle default export must be a fetch handler (createMcpHandler)",
    );
  }

  const mcp = payload.mcpRequest;
  const request = new Request("http://mcp-hosted.internal/mcp", {
    method: mcp.method,
    headers: mcp.headers,
    ...(mcp.body !== undefined && mcp.method !== "GET"
      ? { body: mcp.body }
      : {}),
    signal: abortSignal,
  });
  const response = await fetchLike(request);
  const body = await response.text();

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: body,
  };
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

// The terminal frame carries this request's CPU as a delta from the request
// start, so a reused child still reports exactly what one call cost (the
// first call's delta includes boot and parse, as before). `exitCode` null
// keeps the process alive for the next request; a number retires it after the
// frame is flushed, so a pipe write is never truncated and user code's
// lingering handles cannot keep a failed child around.
function emitTerminal(frame, cpuBaseline, exitCode) {
  if (settled) return;
  settled = exitCode === null ? true : "exiting";
  const cpu = process.cpuUsage(cpuBaseline);
  const stamped = { ...frame, cpuUsec: cpu.user + cpu.system };
  const line = `${JSON.stringify(stamped)}\n`;
  if (exitCode === null) {
    process.stdout.write(line);
  } else {
    process.stdout.write(line, () => process.exit(exitCode));
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parsePayload(payload) {
  if (!payload || typeof payload !== "object" || payload.mode !== "mcp") {
    throw new Error("invalid mcp runner payload");
  }
  if (typeof payload.expectedSha256 !== "string") {
    throw new Error("mcp runner payload missing expectedSha256");
  }
  if (typeof payload.toolName !== "string") {
    throw new Error("mcp runner payload missing toolName");
  }
  const mcp = payload.mcpRequest;
  if (!mcp || typeof mcp !== "object" || typeof mcp.method !== "string") {
    throw new Error("mcp runner payload missing mcpRequest");
  }

  return {
    mode: "mcp",
    expectedSha256: payload.expectedSha256,
    toolName: payload.toolName,
    ...(typeof payload.home === "string" ? { home: payload.home } : {}),
    mcpRequest: {
      method: mcp.method,
      headers:
        mcp.headers && typeof mcp.headers === "object" ? mcp.headers : {},
      body: typeof mcp.body === "string" ? mcp.body : undefined,
    },
  };
}

function runTimeoutMs() {
  const value = Number(process.env.TOOL_RUNNER_TIMEOUT_SECONDS);
  const seconds =
    Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_SECONDS;

  return seconds * 1000;
}
