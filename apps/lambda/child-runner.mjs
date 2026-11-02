// The bundle arrives once on fd 3; each stdin NDJSON line is one batch. Requests answer in
// id-tagged frames, `end` closes the batch, and an untagged error frame retires the process.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const BUNDLE_FD = 3;
const DEFAULT_TIMEOUT_SECONDS = 30;

// Served from memory by the loader hook, yet it must be a file URL: bundlers emit
// `createRequire(import.meta.url)`, which throws on a data: URL.
const BUNDLE_URL = pathToFileURL(
  join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), "broods-mcp-bundle.mjs"),
).href;

let settled = true;
let retiring = false;
let poisoned = false;
process.on("unhandledRejection", (reason) => {
  console.error("[mcp-runner] unhandled rejection:", reason);
  poisoned = true;
  if (settled && !retiring) process.exit(1);
});

await runRequestLoop();

async function runRequestLoop() {
  let bundle = await readBundleBytes();
  const actualSha = createHash("sha256").update(bundle).digest("hex");
  let fetchLike;
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
      // A fresh scratch dir per batch: no invocation sees what another wrote to HOME/TMPDIR.
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
    if (retiring) return;
  }
  process.exit(0);
}

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

// Never on disk: /tmp survives in a warm Lambda sandbox, readable by later processes.
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

// Every frame leads with `t` (then `id` when tagged): handler.mjs classifies lines by prefix.
function emitRequestFrame(frame) {
  if (settled) return;
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

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
