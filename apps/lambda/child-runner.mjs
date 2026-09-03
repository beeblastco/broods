/**
 * Node-native runner for hosted MCP server bundles (#331, warm reuse #189,
 * micro-batching #397). The bundle arrives on fd 3 once at spawn; one batch
 * of requests arrives per NDJSON line on stdin, one line per Lambda
 * invocation. Requests run concurrently, each answered by a frame tagged with
 * its id; the batch closes on `end` and the process stays for the next one.
 * An untagged error frame (timeout, bad payload, unhandled rejection) retires it.
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

// Wall-clock deadline for one batch; the handler also hard-kills the child,
// this is the cooperative in-process bound that trips the request signals first.
const DEFAULT_TIMEOUT_SECONDS = 30;

// The identity the bundle is imported under. Nothing is ever written here — the
// loader hook answers it from memory — but it has to be a file URL: bundlers
// emit `createRequire(import.meta.url)`, which rejects a data: URL outright and
// throws before a line of the server's own code runs.
const BUNDLE_URL = pathToFileURL(
  join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), "broods-mcp-bundle.mjs"),
).href;

// The batch and the timeout race to write the terminal frame; first one wins.
// `true` also means idle — nothing in flight before or between batches.
let settled = true;

// The emitted frame carried an exit code: the process exits once it flushes,
// so the loop must not read another batch.
let retiring = false;

// A stray rejection must not crash the runner mid-frame, but it must not
// serve another call either: mid-batch the child retires after the frame
// flushes, idle it exits on the spot, and a retiring child is left alone (its
// exit is already pending on the flush).
let poisoned = false;
process.on("unhandledRejection", (reason) => {
  console.error("[mcp-runner] unhandled rejection:", reason);
  poisoned = true;
  if (settled && !retiring) process.exit(1);
});

await runRequestLoop();

async function runRequestLoop() {
  // Released after the first import: the module lives in V8's cache, so the
  // raw bytes (up to 50 MB) need not stay pinned for the child's lifetime.
  let bundle = await readBundleBytes();
  const actualSha = createHash("sha256").update(bundle).digest("hex");
  let fetchLike;
  // One batch per line; the handler serializes invocations, so by the time a
  // line arrives the previous batch has already emitted its terminal frame.
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    settled = false;
    const cpuBaseline = process.cpuUsage();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const reason = new Error("mcp server run timed out");
      controller.abort(reason);
      emitTerminal({ t: "error", error: reason.message }, cpuBaseline, 1);
    }, runTimeoutMs());
    try {
      const payload = parsePayload(JSON.parse(line));
      if (payload.expectedSha256 !== actualSha) {
        throw new Error("bundle hash mismatch inside mcp runner");
      }
      // Fresh scratch dir per batch: nothing a call writes to HOME/TMPDIR
      // is visible to the next invocation.
      if (payload.home !== undefined) {
        process.env.HOME = payload.home;
        process.env.TMPDIR = payload.home;
      }
      if (fetchLike === undefined) {
        fetchLike = resolveFetchHandler(await importBundle(bundle));
        bundle = null;
      }
      await Promise.all(
        payload.requests.map(async (request) => {
          try {
            const result = await runMcpRequest(
              fetchLike,
              request.mcpRequest,
              controller.signal,
            );
            emitRequestFrame({ t: "final", id: request.id, result: result });
          } catch (error) {
            emitRequestFrame({
              t: "error",
              id: request.id,
              error: errorMessage(error),
            });
          }
        }),
      );
      clearTimeout(timeout);
      emitTerminal({ t: "end" }, cpuBaseline, poisoned ? 1 : null);
    } catch (error) {
      clearTimeout(timeout);
      emitTerminal({ t: "error", error: errorMessage(error) }, cpuBaseline, 1);
    }
    // A retiring batch has its frame on the wire and its exit pending in the
    // flush callback; reading another line would race the exit.
    if (retiring) return;
  }
  process.exit(0);
}

// The bundle default-exports a fetch-style handler (`createMcpHandler(...)`),
// as a plain function or a { fetch } object.
function resolveFetchHandler(module) {
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

  return fetchLike;
}

async function runMcpRequest(fetchLike, mcp, abortSignal) {
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

function emitRequestFrame(frame) {
  if (settled) return;
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

// CPU is a delta from the batch start, so a reused child reports exactly what
// one invocation cost. `exitCode` null keeps the process alive; a number
// retires it after the frame flushes, so the pipe write is never truncated.
// `t` must stay the frame's first key: handler.mjs classifies terminal frames
// by line prefix without parsing them.
function emitTerminal(frame, cpuBaseline, exitCode) {
  if (settled) return;
  settled = true;
  if (exitCode !== null) retiring = true;
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
  if (!Array.isArray(payload.requests) || payload.requests.length === 0) {
    throw new Error("mcp runner payload missing requests");
  }

  return {
    mode: "mcp",
    expectedSha256: payload.expectedSha256,
    toolName: payload.toolName,
    ...(typeof payload.home === "string" ? { home: payload.home } : {}),
    requests: payload.requests.map(parseRequest),
  };
}

function parseRequest(request) {
  const mcp = request?.mcpRequest;
  if (typeof request?.id !== "string" || request.id === "") {
    throw new Error("mcp runner request missing id");
  }
  if (!mcp || typeof mcp !== "object" || typeof mcp.method !== "string") {
    throw new Error("mcp runner request missing mcpRequest");
  }

  return {
    id: request.id,
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
