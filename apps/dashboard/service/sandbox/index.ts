/**
 * Sandbox HTTP server for isolated custom tool execution.
 * Runs user-submitted JS/Python code in subprocesses with no access to parent secrets.
 */
import { timingSafeEqual } from "node:crypto";
import { executeInSandbox } from "./executor";
import { log } from "./utils";

/** Maximum accepted source code payload size (200 KB). */
const MAX_SOURCE_BYTES = 200_000;

/** Validate shared secret at startup — fail fast on misconfiguration. */
const rawSecret = Bun.env.SANDBOX_SHARED_SECRET;
if (!rawSecret || rawSecret.length < 32) {
  log.error("sandbox:missing_secret", { msg: "SANDBOX_SHARED_SECRET is missing or too short (min 32 chars)" });
  process.exit(1);
}
const SANDBOX_SHARED_SECRET: string = rawSecret;

/** Validate the shared secret header using constant-time comparison. */
function assertSecret(request: Request): void {
  const header = request.headers.get("X-Sandbox-Secret") ?? "";
  if (header.length === 0) {
    throw new Error("Unauthorized");
  }

  const headerBuf = Buffer.from(header);
  const secretBuf = Buffer.from(SANDBOX_SHARED_SECRET);
  const maxLen = Math.max(headerBuf.length, secretBuf.length);
  const aPadded = Buffer.alloc(maxLen);
  const bPadded = Buffer.alloc(maxLen);
  headerBuf.copy(aPadded);
  secretBuf.copy(bPadded);

  if (!timingSafeEqual(aPadded, bPadded) || headerBuf.length !== secretBuf.length) {
    throw new Error("Unauthorized");
  }
}

/** Create a JSON response with standard headers. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Parse and validate the execution request body. */
function parseBody(body: unknown): {
  language: "javascript" | "python";
  sourceCode: string;
  input: unknown;
  timeoutMs?: number;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Invalid request body");
  }

  const { language, sourceCode, input, timeoutMs } = body as Record<string, unknown>;

  if (language !== "javascript" && language !== "python") {
    throw new Error("language must be 'javascript' or 'python'");
  }

  if (typeof sourceCode !== "string" || sourceCode.trim().length === 0) {
    throw new Error("sourceCode is required");
  }

  if (sourceCode.length > MAX_SOURCE_BYTES) {
    throw new Error("sourceCode exceeds maximum size");
  }

  return {
    language: language,
    sourceCode: sourceCode,
    input: input ?? {},
    timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
  };
}

// Catch unhandled errors to log structured output before exiting
process.on("uncaughtException", (err) => {
  log.error("sandbox:uncaught_exception", { error: err.message });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("sandbox:unhandled_rejection", { error: String(reason) });
  process.exit(1);
});

const server = Bun.serve({
  port: Bun.env.SANDBOX_PORT ?? 8971,
  idleTimeout: Number(Bun.env.SANDBOX_IDLE_TIMEOUT_SECONDS) || 0,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse(200, { ok: true });
    }

    // Match POST /sandbox/execute
    if (request.method !== "POST" || url.pathname !== "/sandbox/execute") {
      return jsonResponse(404, { error: "Not found" });
    }

    try {
      assertSecret(request);
    } catch {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }

    let parsed: ReturnType<typeof parseBody>;
    try {
      parsed = parseBody(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bad request";

      return jsonResponse(400, { error: message });
    }

    log.info("sandbox:execute_start", { language: parsed.language });

    const result = await executeInSandbox(
      parsed.language,
      parsed.sourceCode,
      parsed.input,
      parsed.timeoutMs,
    );

    return jsonResponse(200, result);
  },
});

log.info("sandbox:server_started", { port: server.port, idleTimeout: Bun.env.SANDBOX_IDLE_TIMEOUT_SECONDS || 0 });
