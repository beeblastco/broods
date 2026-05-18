/**
 * Node sandbox Lambda for workspace file execution.
 * Keep Node runtime process execution here.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

interface SandboxRequest {
  runtime: "node";
  entry: {
    path: string;
    content: string;
  };
  args?: string[];
  timeoutSeconds: number;
  outputLimitBytes: number;
}

interface SandboxResponse {
  ok: boolean;
  runtime: "node";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export async function handler(event: SandboxRequest): Promise<SandboxResponse> {
  const startedAt = Date.now();
  const workdir = await mkdtemp(join(tmpdir(), "sandbox-node-"));

  try {
    if (event.runtime !== "node") {
      throw new Error("sandbox-node only supports node requests");
    }
    if (!event.entry.path.endsWith(".js")) {
      throw new Error("node sandbox only executes .js files");
    }

    const filePath = join(workdir, basename(event.entry.path));
    await writeFile(filePath, event.entry.content, "utf8");
    const result = await runNodeFile(filePath, event.args ?? [], event.timeoutSeconds, event.outputLimitBytes);
    return {
      ...result,
      runtime: "node",
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      runtime: "node",
      exitCode: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function runNodeFile(
  filePath: string,
  args: string[],
  timeoutSeconds: number,
  outputLimitBytes: number,
): Promise<Omit<SandboxResponse, "runtime" | "durationMs">> {
  const child = spawn(process.execPath, [filePath, ...args], {
    cwd: dirname(filePath),
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      NODE_OPTIONS: "--no-deprecation",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return collectChildResult(child, timeoutSeconds, outputLimitBytes);
}

async function collectChildResult(
  child: ReturnType<typeof spawn>,
  timeoutSeconds: number,
  outputLimitBytes: number,
): Promise<Omit<SandboxResponse, "runtime" | "durationMs">> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutSeconds * 1000);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(timeout);

  const stdout = truncateOutput(Buffer.concat(stdoutChunks), outputLimitBytes);
  const stderr = truncateOutput(Buffer.concat(stderrChunks), outputLimitBytes);
  return {
    ok: exitCode === 0 && !timedOut,
    exitCode,
    stdout: stdout.value,
    stderr: timedOut ? appendTimeout(stderr.value, timeoutSeconds) : stderr.value,
    timedOut,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || ".";
}

function truncateOutput(value: Buffer, limit: number): { value: string; truncated: boolean } {
  if (value.byteLength <= limit) {
    return { value: value.toString("utf8"), truncated: false };
  }

  return {
    value: `${value.subarray(0, limit).toString("utf8")}\n[output truncated]`,
    truncated: true,
  };
}

function appendTimeout(stderr: string, timeoutSeconds: number): string {
  return [stderr, `Timed out after ${timeoutSeconds}s`].filter(Boolean).join("\n");
}
