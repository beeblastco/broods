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
// sha) a tool bundle, runs execute(ctx, input), and returns the structured result
// as the HTTP body. User stdout/stderr goes to the process log, never the socket,
// so the harness reads clean JSON. Foreground-only: detached jobs keep their own
// reaper-aware background path.
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

async function invoke(payload) {
  const def = await loadDefinition(payload);
  const ctx = { config: payload.config, asyncTool: payload.asyncTool, env: {} };
  return await def.execute(ctx, payload.input);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (req.method !== "POST" || req.url !== "/invoke") { res.writeHead(404); res.end(); return; }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "invalid invoke payload" })); return; }
    try {
      const result = await invoke(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
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
  const invoke = `curl -s --unix-socket "$SOCK" -X POST --data-binary @- -H 'content-type: application/json' http://localhost/invoke`;
  return ["bash", "-lc", `${ENSURE_WORKER}\n${invoke}`];
}

// Prewarm-only: start the worker without invoking, so the first real call lands on
// a warm process. Runs in parallel with the model's first response.
export function buildWorkerEnsureCommand(): string[] {
  return ["bash", "-lc", ENSURE_WORKER];
}

export interface WorkerInvokeResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// Parse the worker's single JSON response line. Returns null when the body is not
// the worker protocol (e.g. the worker was unreachable), so the caller can fall
// back to the one-shot runner.
export function parseWorkerResponse(stdout: string): WorkerInvokeResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as WorkerInvokeResult;
    return typeof parsed?.ok === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}
