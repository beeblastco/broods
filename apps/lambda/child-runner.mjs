/**
 * Node-native runner for hosted MCP server bundles (#331). Runs the uploaded
 * bundle in a real Node process — full fetch/timers/AbortController, node:
 * builtins, and any npm deps the bundler inlined. It is spawned per invocation
 * by handler.mjs with a scrubbed env and answers over the NDJSON frame protocol
 * (final/error) the core invoker parses. The run request arrives on stdin; the
 * bundle arrives as raw bytes on fd 3.
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
// this is the cooperative in-process bound that trips the request signal first.
const DEFAULT_TIMEOUT_SECONDS = 30;

// The identity the bundle is imported under. Nothing is ever written here — the
// loader hook answers it from memory — but it has to be a file URL: bundlers
// emit `createRequire(import.meta.url)`, which rejects a data: URL outright and
// throws before a line of the server's own code runs.
const BUNDLE_URL = pathToFileURL(
  join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), "broods-mcp-bundle.mjs"),
).href;

// The timeout and the run's own completion race: process.exit is deferred to the
// stdout flush callback, so without this the aborted run emits a second terminal
// frame after the timeout already wrote one.
let settled = false;

// Stray timers/promises in user code must not crash the runner after the
// terminal frame is on stdout; still log to stderr so real bugs stay visible.
process.on("unhandledRejection", (reason) => {
  console.error("[mcp-runner] unhandled rejection:", reason);
});

await runMcpRequest();

async function runMcpRequest() {
  const controller = new AbortController();
  const timeoutMs = runTimeoutMs();
  const timeout = setTimeout(() => {
    controller.abort(new Error("mcp server run timed out"));
    emitTerminal({ t: "error", error: "mcp server run timed out" }, 1);
  }, timeoutMs);
  try {
    // Both pipes at once: the handler writes the request immediately and the
    // bundle whenever its S3 fetch lands, so neither should gate the other.
    const [request, bundle] = await Promise.all([
      readAllStdin(),
      readBundleBytes(),
    ]);
    const payload = parsePayload(JSON.parse(request));
    const actualSha = createHash("sha256").update(bundle).digest("hex");
    if (actualSha !== payload.expectedSha256) {
      throw new Error("bundle hash mismatch inside mcp runner");
    }
    const result = await runMcpBundle(payload, bundle, controller.signal);
    clearTimeout(timeout);
    emitTerminal({ t: "final", result: result }, 0);
  } catch (error) {
    clearTimeout(timeout);
    emitTerminal({ t: "error", error: errorMessage(error) }, 1);
  }
}

// The bundle default-exports a fetch-style MCP handler (e.g.
// `createMcpHandler(...)` from @modelcontextprotocol/server). One invoke
// carries exactly one web request; the stateless 2026-07-28 transport is what
// makes that mapping complete.
async function runMcpBundle(payload, bundle, abortSignal) {
  const module = await importBundle(bundle);
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

// The terminal frame carries this run's CPU. The child is one process per
// request, so its own cpuUsage is exactly what the call cost, S3 fetch and
// parse in.
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
