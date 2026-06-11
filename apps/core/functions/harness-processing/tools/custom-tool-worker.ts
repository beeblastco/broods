/**
 * Resident in-pod tool worker (Convex node-executor style, adapted to our exec
 * transport). A long-lived Node HTTP server runs inside the sandbox pod and
 * executes uploaded tool bundles on `/invoke`, keeping bundles imported in memory
 * across calls. The harness reaches it via `curl` over a unix socket through the
 * k8s exec channel, so a tool call no longer pays a fresh `node` startup.
 *
 * This file owns the worker source and the bash that ensures it is running and
 * pipes one invocation. Tool-call orchestration stays in custom-tool-executor.ts.
 */

const WORKER_SOCK = "${HOME:-/tmp}/.beeblast-worker.sock";
const WORKER_JS = "${HOME:-/tmp}/.beeblast-worker.mjs";
const WORKER_LOG = "${HOME:-/tmp}/.beeblast-worker.log";
const WORKER_HEREDOC_TAG = "__BEEBLAST_WORKER_SRC__";

// The worker process. Listens on a unix socket; `/invoke` loads (and memoizes by
// sha) a tool bundle and runs execute(ctx, input). The response is an NDJSON
// stream (one JSON frame per line) so a tool whose execute is an async generator
// streams partial output live: each `yield` becomes a `chunk` frame, a plain
// return becomes a single `final` frame, and a throw becomes an `error` frame.
// User stdout/stderr goes to the process log, never the socket, so the harness
// reads clean frames. Foreground-only: detached jobs keep their own reaper-aware
// background path.
const WORKER_SOURCE = String.raw`
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { unlinkSync } from "node:fs";

const SOCK = process.env.BEEBLAST_WORKER_SOCK || (process.env.HOME || "/tmp") + "/.beeblast-worker.sock";
const moduleCache = new Map(); // sha -> Promise<definition>

async function cacheDir(sha) {
  const roots = ["/cache/tools", process.env.HOME ? path.join(process.env.HOME, ".cache/tools") : undefined, "/tmp/cache/tools"].filter(Boolean);
  let lastError;
  for (const root of roots) {
    const dir = path.join(root, sha);
    try { await mkdir(dir, { recursive: true }); return dir; } catch (e) { lastError = e; }
  }
  throw lastError ?? new Error("failed to create tool cache directory");
}

async function fileHash(filePath) {
  try { return createHash("sha256").update(await readFile(filePath)).digest("hex"); } catch { return null; }
}

function loadDefinition(payload) {
  const sha = payload.expectedSha256;
  if (moduleCache.has(sha)) return moduleCache.get(sha);
  const p = (async () => {
    const dir = await cacheDir(sha);
    const bundlePath = path.join(dir, "tool.mjs");
    if ((await fileHash(bundlePath)) !== sha) {
      const source = payload.bundleSourceB64 !== undefined
        ? Buffer.from(payload.bundleSourceB64, "base64")
        : Buffer.from(await (await fetch(payload.bundleUrl)).arrayBuffer());
      const tempPath = bundlePath + "." + process.pid + ".tmp";
      await writeFile(tempPath, source);
      if ((await fileHash(tempPath)) !== sha) throw new Error("custom tool bundle hash mismatch inside worker");
      await rename(tempPath, bundlePath);
    }
    const mod = await import(pathToFileURL(bundlePath).href + "?sha=" + sha);
    const exported = mod.default;
    const def = typeof exported === "function" ? await exported() : exported;
    if (!def || typeof def.execute !== "function") throw new Error("custom tool bundle default export must expose execute(ctx, input)");
    if (def.name && def.name !== payload.toolName) throw new Error("custom tool bundle name does not match uploaded manifest");
    return def;
  })();
  moduleCache.set(sha, p);
  p.catch(() => moduleCache.delete(sha)); // never memoize a failed load
  return p;
}

function isAsyncIterable(value) {
  return value != null && typeof value[Symbol.asyncIterator] === "function";
}

// Run the tool and stream NDJSON frames. Mirrors the Vercel AI SDK convention:
// every yield is an intermediate (chunk); the last yield is also the final output.
// A non-iterable execute returns one final frame. errMsg lets a failed load report
// without first having to know whether the tool streams.
async function streamInvoke(payload, res) {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  const write = (frame) => res.write(JSON.stringify(frame) + "\n");
  try {
    const def = await loadDefinition(payload);
    const ctx = { config: payload.config, asyncTool: payload.asyncTool, env: {} };
    const result = def.execute(ctx, payload.input);
    if (isAsyncIterable(result)) {
      for await (const output of result) write({ t: "chunk", output });
      write({ t: "end" });
    } else {
      write({ t: "final", result: await result });
    }
    res.end();
  } catch (error) {
    write({ t: "error", error: error instanceof Error ? error.message : String(error) });
    res.end();
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (req.method !== "POST" || req.url !== "/invoke") { res.writeHead(404); res.end(); return; }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ t: "error", error: "invalid invoke payload" }) + "\n"); return; }
    await streamInvoke(payload, res);
  });
});

try { unlinkSync(SOCK); } catch {}
server.listen(SOCK);
`;

// Bash that starts the worker if it is not already serving health on the socket.
// Idempotent and safe to run repeatedly (at prewarm and on every invoke).
const ENSURE_WORKER = [
  `SOCK="${WORKER_SOCK}"`,
  `WJS="${WORKER_JS}"`,
  `if ! curl -s --unix-socket "$SOCK" http://localhost/health >/dev/null 2>&1; then`,
  `cat > "$WJS" <<'${WORKER_HEREDOC_TAG}'`,
  WORKER_SOURCE,
  WORKER_HEREDOC_TAG,
  `rm -f "$SOCK"`,
  `setsid node "$WJS" >"${WORKER_LOG}" 2>&1 </dev/null &`,
  `for i in $(seq 1 100); do curl -s --unix-socket "$SOCK" http://localhost/health >/dev/null 2>&1 && break; sleep 0.05; done`,
  `fi`,
].join("\n");

// One exec per call: ensure the worker is up, then POST the invocation, reading the
// payload JSON from this command's stdin (so bundle size is never bounded by argv
// limits). User code never touches this stdout — only the worker's JSON response.
export function buildWorkerInvokeCommand(): string[] {
  // -N disables curl's output buffering: without it, curl block-buffers stdout
  // (a pipe, not a TTY), so small NDJSON frames flush only when curl exits and
  // streamed yields arrive in one burst instead of live.
  const invoke = `curl -sN --unix-socket "$SOCK" -X POST --data-binary @- -H 'content-type: application/json' http://localhost/invoke`;
  return ["bash", "-lc", `${ENSURE_WORKER}\n${invoke}`];
}

// Prewarm-only: start the worker without invoking, so the first real call lands on
// a warm process. Runs in parallel with the model's first response.
export function buildWorkerEnsureCommand(): string[] {
  return ["bash", "-lc", ENSURE_WORKER];
}

// One line of the worker's NDJSON response. `chunk` is an intermediate streamed
// output; `final` carries the whole result of a non-streaming tool; `end` closes a
// streamed tool (its last chunk was the final output); `error` is a tool failure.
export type WorkerFrame =
  | { t: "chunk"; output: unknown }
  | { t: "final"; result: unknown }
  | { t: "end" }
  | { t: "error"; error: string };

// Parse one NDJSON line into a frame. Returns null for blank or non-protocol lines
// (e.g. a curl connection-refused message when the worker is unreachable), so the
// caller can tell "no frames" (fall back to the one-shot runner) from a real error.
export function parseWorkerFrame(line: string): WorkerFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as WorkerFrame;
    if (parsed && (parsed.t === "chunk" || parsed.t === "final" || parsed.t === "end" || parsed.t === "error")) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
