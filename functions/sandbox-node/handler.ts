/**
 * Node sandbox Lambda for workspace file execution.
 * Keep Node runtime process execution here.
 */

import { access, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import ts from "typescript";
import type { Stats } from "node:fs";

interface SandboxRequest {
  runtime: "node";
  namespace: string;
  entryPath: string;
  args?: string[];
  workspaceRoot?: string;
  timeoutSeconds: number;
  outputLimitBytes: number;
}

interface SandboxResponse {
  ok: boolean;
  runtime: "node";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  artifacts?: SandboxArtifact[];
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
}

interface SandboxArtifact {
  kind: "file";
  path: string;
  mediaType: string;
  dataBase64: string;
  metadata: {
    size: number;
  };
}

interface WorkspaceSnapshot {
  files: Map<string, { mtimeMs: number; size: number }>;
}

const MAX_ARTIFACT_BYTES = 256 * 1024;
const ENTRY_FILE_WAIT_MS = 5000;
const ENTRY_FILE_WAIT_INTERVAL_MS = 100;

export async function handler(event: SandboxRequest): Promise<SandboxResponse> {
  const startedAt = Date.now();

  try {
    if (event.runtime !== "node") {
      throw new Error("sandbox-node only supports node requests");
    }
    if (!event.entryPath.endsWith(".js") && !event.entryPath.endsWith(".ts")) {
      throw new Error("node sandbox only executes .js and .ts files");
    }

    const workspaceRoot = resolveWorkspaceRoot(event.workspaceRoot, event.namespace);
    const filePath = resolveWorkspacePath(workspaceRoot, event.entryPath);
    await waitForFile(filePath);
    const before = await snapshotWorkspace(workspaceRoot);
    const executablePath = event.entryPath.endsWith(".ts") ? await prepareTypescriptEntry(filePath, workspaceRoot) : filePath;
    const result = await runNodeFile(executablePath, workspaceRoot, event.args ?? [], event.timeoutSeconds, event.outputLimitBytes);
    return {
      ...result,
      runtime: "node",
      artifacts: await collectChangedArtifacts(workspaceRoot, before),
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
  }
}

async function prepareTypescriptEntry(filePath: string, workspaceRoot: string): Promise<string> {
  const source = await readFile(filePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      sourceMap: false,
    },
    fileName: filePath,
  }).outputText;
  const generatedPath = resolveTypescriptOutputPath(filePath, workspaceRoot, source);
  await writeFile(generatedPath, transpiled, "utf8");
  return generatedPath;
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + ENTRY_FILE_WAIT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, ENTRY_FILE_WAIT_INTERVAL_MS));
    }
  }

  if (lastError) {
    throw lastError;
  }
  await access(filePath);
}

async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const files = new Map<string, { mtimeMs: number; size: number }>();
  await walkWorkspace(root, async (path, stats) => {
    files.set(relative(root, path), {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    });
  });
  return { files };
}

async function collectChangedArtifacts(root: string, before: WorkspaceSnapshot): Promise<SandboxArtifact[]> {
  const artifacts: SandboxArtifact[] = [];
  await walkWorkspace(root, async (path, stats) => {
    const relativePath = relative(root, path);
    const previous = before.files.get(relativePath);
    if (previous?.mtimeMs === stats.mtimeMs && previous.size === stats.size) {
      return;
    }
    if (stats.size > MAX_ARTIFACT_BYTES) {
      return;
    }

    const content = await readFile(path);
    artifacts.push({
      kind: "file",
      path: `/${relativePath}`,
      mediaType: "application/octet-stream",
      dataBase64: content.toString("base64"),
      metadata: {
        size: stats.size,
      },
    });
  });
  return artifacts;
}

async function walkWorkspace(
  root: string,
  visit: (path: string, stats: Stats) => Promise<void>,
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") {
      continue;
    }

    const path = resolve(root, entry.name);
    const stats = await stat(path);
    if (stats.isDirectory()) {
      await walkWorkspace(path, visit);
      continue;
    }
    if (stats.isFile()) {
      await visit(path, stats);
    }
  }
}

function resolveTypescriptOutputPath(filePath: string, workspaceRoot: string, source: string): string {
  const fileName = basename(filePath).replace(/\.ts$/, "");
  const hash = createHash("sha256").update(filePath).update("\0").update(source).digest("hex").slice(0, 16);
  const generated = resolve(dirname(filePath), `.${fileName}-${hash}.js`);
  const relation = relative(workspaceRoot, generated);
  if (relation.startsWith("..") || relation === ".." || relation === "" || relation.startsWith("/")) {
    throw new Error("Invalid generated entry path: resolved outside workspace root");
  }
  return generated;
}

async function runNodeFile(
  filePath: string,
  cwd: string,
  args: string[],
  timeoutSeconds: number,
  outputLimitBytes: number,
): Promise<Omit<SandboxResponse, "runtime" | "durationMs">> {
  const child = spawn(process.execPath, [filePath, ...args], {
    cwd: cwd,
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

function resolveWorkspaceRoot(root: string | undefined, namespace: string): string {
  assertSafeNamespace(namespace);
  return resolve(root || "/mnt/workspaces", namespace);
}

function resolveWorkspacePath(workspaceRoot: string, entryPath: string): string {
  const normalizedEntry = entryPath.startsWith("/") ? entryPath.slice(1) : entryPath;
  const resolved = resolve(workspaceRoot, normalizedEntry);
  const relation = relative(workspaceRoot, resolved);
  if (relation.startsWith("..") || relation === ".." || relation === "" || relation.startsWith("/")) {
    throw new Error("Invalid entry path: resolved outside workspace root");
  }
  return resolved;
}

function assertSafeNamespace(namespace: string): void {
  if (!/^fs-[a-f0-9]{40}$/.test(namespace)) {
    throw new Error("Invalid workspace namespace");
  }
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
