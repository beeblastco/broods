/**
 * Subprocess executor for sandboxed JS/Python tool code.
 * Each invocation spawns a short-lived process with a result file protocol
 * to avoid user stdout pollution corrupting the JSON output.
 */
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { randomUUIDv7 } from "bun";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./utils";

/** Default execution timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Hard ceiling on execution timeout. */
const MAX_TIMEOUT_MS = 60_000;

/** Maximum stdout/stderr size collected from subprocess (10 MB). */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Structured result from sandbox execution. */
export type ExecutionResult =
  | { success: true; output: ToolResultOutput }
  | { success: false; error: string };

type RawExecutionResult =
  | { success: true; output?: unknown }
  | { success: false; error?: string };

const CONTENT_PART_TYPES = new Set([
  "text",
  "media",
  "file-data",
  "file-url",
  "file-id",
  "image-data",
  "image-url",
  "image-file-id",
  "custom",
]);

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Minimal env passed to sandboxed subprocesses (only PATH for binary lookup). */
const SANDBOX_ENV: Record<string, string> = {
  PATH: Bun.env.PATH || DEFAULT_PATH,
};

/**
 * Execute user-provided tool code in an isolated subprocess.
 * @param language Runtime language ("javascript" or "python")
 * @param sourceCode User-written handler source code
 * @param input JSON-serializable input passed to the handler
 * @param timeoutMs Maximum execution time (capped at 60s)
 * @returns Structured execution result
 */
export async function executeInSandbox(
  language: "javascript" | "python",
  sourceCode: string,
  input: unknown,
  timeoutMs?: number,
): Promise<ExecutionResult> {
  const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const id = randomUUIDv7();
  const dir = tmpdir();

  const ext = language === "javascript" ? "mjs" : "py";
  const handlerFile = join(dir, `sandbox_${id}_handler.${ext}`);
  const wrapperFile = join(dir, `sandbox_${id}_wrapper.${ext}`);
  const resultFile = join(dir, `sandbox_${id}_result.json`);

  const wrapperCode = language === "javascript"
    ? buildJsWrapper(handlerFile, resultFile)
    : buildPyWrapper(handlerFile, resultFile);

  const bunRuntime = Bun.which("bun") ?? "bun";
  const cmd = language === "javascript"
    ? [bunRuntime, "run", wrapperFile]
    : ["python3", wrapperFile];

  try {
    await Promise.all([
      writeFile(handlerFile, sourceCode, "utf-8"),
      writeFile(wrapperFile, wrapperCode, "utf-8"),
    ]);

    log.info("sandbox:subprocess_spawn", { id: id, language: language, timeoutMs: timeout });
    const result = await runSubprocess(cmd, JSON.stringify(input), timeout, resultFile);

    if (result.success) {
      log.info("sandbox:execute_complete", { id: id, language: language });
    } else {
      log.warn("sandbox:execute_failed", { id: id, language: language, error: result.error });
    }

    return result;
  } finally {
    await Promise.all([
      unlink(handlerFile).catch(() => {}),
      unlink(wrapperFile).catch(() => {}),
      unlink(resultFile).catch(() => {}),
    ]);
  }
}

/** Returns true if value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and normalizes user-controlled output into a proper ToolResultOutput.
 * Each branch structurally validates the value field before returning.
 */
function normalizeToolResultOutput(output: unknown): ToolResultOutput {
  if (isRecord(output) && typeof output.type === "string") {
    if (output.type === "text" || output.type === "error-text") {
      if (typeof output.value === "string") {
        return { type: output.type, value: output.value };
      }
    }

    if (output.type === "json" || output.type === "error-json") {
      if ("value" in output) {
        return { type: output.type, value: output.value } as ToolResultOutput;
      }
    }

    if (output.type === "execution-denied") {
      const reason = output.reason;
      if (reason === undefined || typeof reason === "string") {
        return { type: "execution-denied", reason: reason } as ToolResultOutput;
      }
    }

    if (output.type === "content" && Array.isArray(output.value)) {
      return { type: "content", value: output.value } as ToolResultOutput;
    }

    if (CONTENT_PART_TYPES.has(output.type)) {
      return {
        type: "content",
        value: [output],
      } as ToolResultOutput;
    }
  }

  if (typeof output === "string") {
    return { type: "text", value: output };
  }

  return { type: "json", value: output ?? null } as ToolResultOutput;
}

/**
 * Build the JS wrapper that writes the result to a file instead of stdout.
 * User code can freely use console.log without corrupting the protocol.
 */
function buildJsWrapper(handlerFile: string, resultFile: string): string {
  return [
    `import handler from ${JSON.stringify(handlerFile)};`,
    `const input = JSON.parse(await Bun.stdin.text());`,
    `try {`,
    `  const result = await handler(input);`,
    `  await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({ success: true, output: result }));`,
    `} catch (err) {`,
    `  const message = err instanceof Error ? err.message : String(err);`,
    `  await Bun.write(${JSON.stringify(resultFile)}, JSON.stringify({ success: false, error: message }));`,
    `}`,
  ].join("\n");
}

/**
 * Build the Python wrapper that writes the result to a file instead of stdout.
 * User code can freely use print() without corrupting the protocol.
 */
function buildPyWrapper(handlerFile: string, resultFile: string): string {
  return [
    `import sys, json, importlib.util, asyncio`,
    `spec = importlib.util.spec_from_file_location("handler_mod", ${JSON.stringify(handlerFile)})`,
    `mod = importlib.util.module_from_spec(spec)`,
    `spec.loader.exec_module(mod)`,
    `handler = getattr(mod, "handler")`,
    `input_data = json.loads(sys.stdin.read())`,
    `try:`,
    `    if asyncio.iscoroutinefunction(handler):`,
    `        result = asyncio.run(handler(input_data))`,
    `    else:`,
    `        result = handler(input_data)`,
    `    with open(${JSON.stringify(resultFile)}, "w") as f:`,
    `        json.dump({"success": True, "output": result}, f)`,
    `except Exception as e:`,
    `    with open(${JSON.stringify(resultFile)}, "w") as f:`,
    `        json.dump({"success": False, "error": str(e)}, f)`,
  ].join("\n");
}

/**
 * Read stdout from a ReadableStream with a byte cap to prevent memory exhaustion.
 * @param stream ReadableStream from subprocess
 * @param maxBytes Maximum bytes to collect
 * @returns Collected text, truncated if exceeded
 */
async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        chunks.push(value.slice(0, value.byteLength - (totalBytes - maxBytes)));
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(Math.min(totalBytes, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(combined);
}

/**
 * Spawn a subprocess, pipe input via stdin, and read the result from a temp file.
 * Kills the process group if it exceeds the timeout.
 */
async function runSubprocess(
  cmd: string[],
  stdinData: string,
  timeoutMs: number,
  resultFile: string,
): Promise<ExecutionResult> {
  let timedOut = false;

  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: SANDBOX_ENV,
  });

  proc.stdin.write(stdinData);
  proc.stdin.end();

  const timer = setTimeout(() => {
    timedOut = true;
    // SIGKILL to ensure the process and any children are terminated
    proc.kill("SIGKILL");
  }, timeoutMs);

  try {
    const exitCode = await proc.exited;
    clearTimeout(timer);

    // Drain stdout/stderr with a cap to prevent memory exhaustion
    const stderr = await readCapped(proc.stderr, MAX_OUTPUT_BYTES);

    if (timedOut) {
      log.warn("sandbox:subprocess_timeout", { timeoutMs: timeoutMs });

      return { success: false, error: `Execution timed out after ${timeoutMs}ms` };
    }

    if (exitCode !== 0) {
      const message = stderr.trim() || `Process exited with code ${exitCode}`;

      return { success: false, error: message };
    }

    // Read the result from the temp file (avoids stdout pollution from user code)
    let resultJson: string;
    try {
      resultJson = await readFile(resultFile, "utf-8");
    } catch {
      return { success: false, error: "Handler produced no output (result file not written)" };
    }

    const trimmed = resultJson.trim();
    if (trimmed.length === 0) {
      return { success: false, error: "Handler produced no output" };
    }

    const parsed = JSON.parse(trimmed) as RawExecutionResult;
    if (!isRecord(parsed) || typeof parsed.success !== "boolean") {
      return { success: false, error: "Invalid sandbox response format" };
    }

    if (!parsed.success) {
      return {
        success: false,
        error: typeof parsed.error === "string" ? parsed.error : "Tool execution failed",
      };
    }

    return {
      success: true,
      output: normalizeToolResultOutput(parsed.output),
    };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);

    return { success: false, error: `Sandbox error: ${message}` };
  }
}
