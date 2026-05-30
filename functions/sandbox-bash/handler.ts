/**
 * Bash sandbox Lambda for mounted workspace shell execution.
 * Keep shell interpretation and native Node bridging here.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";
import {
  Bash,
  ReadWriteFs,
  type Command,
  type CommandContext,
  type ExecResult,
  type NetworkConfig,
} from "just-bash";

interface SandboxBashRequest {
  runtime: "shell";
  namespace: string;
  shell: string;
  workspaceRoot?: string;
  timeoutSeconds: number;
  outputLimitBytes: number;
  networkAccess?: "disabled" | "public";
  envVars?: Record<string, string>;
}

interface SandboxReadDirRequest {
  runtime: "read-dir";
  namespace: string;
  path: string;
  workspaceRoot?: string;
  maxBytes?: number;
}

interface SandboxBashResponse {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  truncated?: boolean;
}

interface SandboxReadDirResponse {
  ok: boolean;
  files: Array<{ path: string; base64: string }>;
  truncated?: boolean;
  error?: string;
}

const READ_DIR_DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

interface NativeNodeOptions {
  workspaceRoot: string;
  timeoutSeconds: number;
  outputLimitBytes: number;
  envVars: Record<string, string>;
}

const textDecoder = new TextDecoder();

export async function handler(
  event: SandboxBashRequest | SandboxReadDirRequest,
): Promise<SandboxBashResponse | SandboxReadDirResponse> {
  if (event.runtime === "read-dir") {
    return readWorkspaceDirectory(event);
  }

  const startedAt = Date.now();

  try {
    if (event.runtime !== "shell") {
      throw new Error("sandbox-bash only supports shell and read-dir requests");
    }

    const workspaceRoot = resolveWorkspaceRoot(event.workspaceRoot, event.namespace);
    await mkdir(workspaceRoot, { recursive: true });

    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, boundedTimeoutSeconds(event.timeoutSeconds) * 1000);

    // Account-configured env vars are merged in first so the required shell vars
    // below always win; process.env is never inherited (no AWS-credential leak).
    const configuredEnvVars = event.envVars ?? {};
    const shellEnv = {
      ...configuredEnvVars,
      HOME: "/",
      USER: "agent",
      SHELL: "/bin/bash",
      PATH: "/usr/bin:/bin",
    };

    try {
      const bash = new Bash({
        cwd: "/",
        fs: new ReadWriteFs({
          root: workspaceRoot,
          allowSymlinks: false,
          maxFileReadSize: 10 * 1024 * 1024,
        }),
        env: shellEnv,
        network: networkConfig(event.networkAccess),
        // just-bash's own JS/TS runtime (`js-exec`) is QuickJS WASM with only a
        // curated subset of Node built-ins. We disable it and register a `node`
        // command below that spawns the real Node binary instead, so node files
        // run on full Node 22. Limitations are operational, not runtime-fidelity:
        // file-only (no -e/REPL), .js/.ts only, and no package manager on PATH
        // (no npm/npx). Account-configured env vars are injected; nothing else.
        javascript: false,
        // just-bash's built-in `python`/`python3` is CPython-compiled-to-WASM
        // run in a worker spawned from a sibling `worker.js` asset. esbuild does
        // not emit that `import.meta.url`-relative worker (or its WASM payload)
        // next to this bundled Lambda, so the worker never starts and its promise
        // never settles -> the Lambda dies with "NodeJsExit". We disable it and
        // register a `python`/`python3` stub below that fails cleanly instead of
        // crashing the whole shell call. Real Python runs on the dedicated
        // SandboxPython (python3.12) Lambda: the bash tool routes a *standalone*
        // `python <file>.py` there (see filesystem.tool.ts) for full CPython.
        python: false,
        // defenseInDepth must stay OFF here. It wraps host globals
        // (process.env/stdout, timers, WebAssembly, Atomics) in blocking Proxies
        // for the duration of exec and restores them afterwards — but if exec is
        // interrupted (e.g. the Lambda freezes mid-run) the restore never runs and
        // the process.env Proxy leaks into the warm container, so the next
        // invocation's AWS X-Ray setup (`process.env._X_AMZN_TRACE_ID = ...`)
        // throws. The isolation boundary is the Lambda itself: jailed
        // ReadWriteFs, replaced env (no host vars, no AWS creds), and
        // javascript:false (no QuickJS host bridge).
        defenseInDepth: false,
        executionLimits: {
          maxCommandCount: 10000,
          maxLoopIterations: 10000,
          maxCallDepth: 1000,
        },
      });
      bash.registerCommand(nativeNodeCommand({
        workspaceRoot,
        timeoutSeconds: boundedTimeoutSeconds(event.timeoutSeconds),
        outputLimitBytes: boundedOutputLimit(event.outputLimitBytes),
        envVars: configuredEnvVars,
      }));
      // No Python runtime lives in this Node Lambda; redirect callers to the
      // standalone path the bash tool routes to SandboxPython.
      bash.registerCommand(pythonRedirectCommand("python"));
      bash.registerCommand(pythonRedirectCommand("python3"));

      const result = await bash.exec(event.shell, {
        cwd: "/",
        signal: abortController.signal,
        replaceEnv: true,
        env: shellEnv,
      });
      const stdout = truncateOutput(Buffer.from(result.stdout), boundedOutputLimit(event.outputLimitBytes));
      const stderr = truncateOutput(Buffer.from(result.stderr), boundedOutputLimit(event.outputLimitBytes));
      return {
        ok: result.exitCode === 0 && !timedOut,
        exitCode: result.exitCode,
        stdout: stdout.value,
        stderr: timedOut ? appendTimeout(stderr.value, event.timeoutSeconds) : stderr.value,
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function readWorkspaceDirectory(event: SandboxReadDirRequest): Promise<SandboxReadDirResponse> {
  try {
    const workspaceRoot = resolveWorkspaceRoot(event.workspaceRoot, event.namespace);
    const targetDir = resolveWorkspacePath(workspaceRoot, event.path);
    const maxBytes = event.maxBytes && event.maxBytes > 0 ? event.maxBytes : READ_DIR_DEFAULT_MAX_BYTES;

    const files: Array<{ path: string; base64: string }> = [];
    let total = 0;
    let truncated = false;

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (truncated) return;
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;

        const bytes = await readFile(absolute);
        if (total + bytes.byteLength > maxBytes) {
          truncated = true;
          return;
        }
        total += bytes.byteLength;
        files.push({
          path: relative(targetDir, absolute),
          base64: bytes.toString("base64"),
        });
      }
    };

    await walk(targetDir);
    return { ok: true, files, ...(truncated ? { truncated: true } : {}) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // A missing directory is an empty checkout, not a failure.
    if (/ENOENT/.test(error)) {
      return { ok: true, files: [] };
    }
    return { ok: false, files: [], error };
  }
}

function pythonRedirectCommand(name: "python" | "python3"): Command {
  return {
    name,
    trusted: true,
    async execute(): Promise<ExecResult> {
      return {
        stdout: "",
        stderr:
          `${name} is not available inside a combined shell command. Run it as a ` +
          `standalone command — e.g. \`${name} <file>.py\` with no other commands in ` +
          `the same call — so it executes on the dedicated CPython sandbox.\n`,
        exitCode: 127,
      };
    },
  };
}

function nativeNodeCommand(options: NativeNodeOptions): Command {
  return {
    name: "node",
    trusted: true,
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      const entryPath = args[0];
      if (!entryPath || entryPath.startsWith("-")) {
        return {
          stdout: "",
          stderr: "node execution must reference one workspace .js or .ts file and cannot use inline flags\n",
          exitCode: 2,
        };
      }

      const virtualEntry = ctx.fs.resolvePath(ctx.cwd, entryPath);
      if (!virtualEntry.endsWith(".js") && !virtualEntry.endsWith(".ts")) {
        return {
          stdout: "",
          stderr: "node execution only supports .js and .ts files\n",
          exitCode: 2,
        };
      }

      try {
        const filePath = resolveWorkspacePath(options.workspaceRoot, virtualEntry);
        const executablePath = virtualEntry.endsWith(".ts")
          ? await prepareTypescriptEntry(filePath, options.workspaceRoot)
          : filePath;
        return await runNodeFile(executablePath, options.workspaceRoot, args.slice(1), ctx, options);
      } catch (err) {
        return {
          stdout: "",
          stderr: `${err instanceof Error ? err.message : String(err)}\n`,
          exitCode: 1,
        };
      }
    },
  };
}

async function prepareTypescriptEntry(filePath: string, workspaceRoot: string): Promise<string> {
  const source = await readFile(filePath, "utf8");
  // Emit CommonJS, not ESM. The transpiled file is written with a `.js` extension,
  // which Node treats as CommonJS unless a `package.json` with `"type":"module"` is
  // present — ESM output would throw "Cannot use import statement outside a module".
  // CommonJS keeps `import`/`export` working out of the box. Trade-off: top-level
  // `await` is unavailable in CommonJS; wrap it in an async function if needed.
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
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

async function runNodeFile(
  filePath: string,
  cwd: string,
  args: string[],
  ctx: CommandContext,
  options: NativeNodeOptions,
): Promise<ExecResult> {
  const child = spawn(process.execPath, [filePath, ...args], {
    cwd,
    env: {
      // Account-configured vars first; required runtime vars below always win.
      ...options.envVars,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      NODE_OPTIONS: "--no-deprecation",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (ctx.stdin) {
    child.stdin?.end(Buffer.from(ctx.stdin as unknown as string, "latin1"));
  } else {
    child.stdin?.end();
  }

  const result = await collectChildResult(child, options.timeoutSeconds, options.outputLimitBytes);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

function resolveWorkspaceRoot(root: string | undefined, namespace: string): string {
  assertSafeNamespace(namespace);
  return resolve(root || process.env.SANDBOX_WORKSPACE_MOUNT_PATH || "/mnt/workspaces", namespace);
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

function networkConfig(access: SandboxBashRequest["networkAccess"]): NetworkConfig | undefined {
  if (access !== "public") {
    return undefined;
  }

  return {
    dangerouslyAllowFullInternetAccess: true,
    denyPrivateRanges: true,
    maxRedirects: 10,
    timeoutMs: 30000,
    maxResponseSize: 10 * 1024 * 1024,
  };
}

function assertSafeNamespace(namespace: string): void {
  if (!/^fs-[a-f0-9]{40}$/.test(namespace)) {
    throw new Error("Invalid workspace namespace");
  }
}

function boundedTimeoutSeconds(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 120) : 30;
}

function boundedOutputLimit(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 262144) : 65536;
}

async function collectChildResult(
  child: ReturnType<typeof spawn>,
  timeoutSeconds: number,
  outputLimitBytes: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
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
    exitCode,
    stdout: stdout.value,
    stderr: timedOut ? appendTimeout(stderr.value, timeoutSeconds) : stderr.value,
  };
}

function truncateOutput(value: Buffer, limit: number): { value: string; truncated: boolean } {
  if (value.byteLength <= limit) {
    return { value: textDecoder.decode(value), truncated: false };
  }

  return {
    value: `${textDecoder.decode(value.subarray(0, limit))}\n[output truncated]`,
    truncated: true,
  };
}

function appendTimeout(stderr: string, timeoutSeconds: number): string {
  return [stderr, `Timed out after ${timeoutSeconds}s`].filter(Boolean).join("\n");
}
