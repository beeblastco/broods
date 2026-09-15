/**
 * `broods machine <sandbox>`: this computer becomes the sandbox behind a
 * machine record. One WebSocket out, a `bash -lc` per exec frame, and a
 * reconnect loop for anything but a refusal. The host environment is
 * inherited on purpose: the agent gets the PATH, keychains and CLIs the user
 * has.
 */

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import {
  MACHINE_CLOSE,
  machineSocketUrl,
  parseCoreFrame,
  type MachineDaemonFrame,
  type MachineExecFrame,
  type MachineResultFrame,
} from "../../../../apps/core/src/shared/machine-socket.ts";
import { reconnectDelay, resolveWebSocket } from "../observability-client.ts";
import { webSocketSubprotocols } from "../websocket.ts";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const LOG_CODE_WIDTH = 72;
// Refusals a reconnect would only repeat.
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  MACHINE_CLOSE.replaced.code,
  MACHINE_CLOSE.unauthorized.code,
  MACHINE_CLOSE.unknownSandbox.code,
]);

export interface MachineDaemonOptions {
  apiKey: string;
  baseUrl: string;
  /** Working directory for an exec that names none. */
  cwd: string;
  log: (line: string) => void;
  sandbox: string;
  signal: AbortSignal;
}

/** Serve core until the signal aborts. Throws with core's reason on a refusal. */
export async function runMachineDaemon(
  options: MachineDaemonOptions,
): Promise<void> {
  const WebSocketImpl = resolveWebSocket();
  let delayMs = RECONNECT_MIN_MS;
  while (!options.signal.aborted) {
    const startedAt = Date.now();
    const closed = await serveOnce(options, WebSocketImpl);
    if (options.signal.aborted) return;
    if (FATAL_CLOSE_CODES.has(closed.code)) {
      throw new Error(
        closed.reason || `core closed the socket (${closed.code})`,
      );
    }
    // A session that lasted is a healthy one: restart the backoff.
    if (Date.now() - startedAt > RECONNECT_MAX_MS) delayMs = RECONNECT_MIN_MS;
    options.log(
      `disconnected (${closed.reason || closed.code}), reconnecting in ${Math.round(delayMs / 1000)}s`,
    );
    await reconnectDelay(delayMs, options.signal);
    delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
  }
}

/**
 * Run one exec frame here. `signal` is the socket's lifetime: once it aborts
 * nobody can receive the result, so the command's process group is killed.
 */
export function runExec(
  frame: MachineExecFrame,
  defaultCwd: string,
  signal?: AbortSignal,
): Promise<MachineResultFrame> {
  return new Promise((resolve): void => {
    const startedAt = performance.now();
    const stdout = new OutputBuffer(frame.outputLimitBytes);
    const stderr = new OutputBuffer(frame.outputLimitBytes);
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, failure?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (failure) stderr.append(Buffer.from(`${failure}\n`));
      resolve({
        type: "result",
        id: frame.id,
        exitCode: exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Math.round(performance.now() - startedAt),
        timedOut: timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    };

    // Its own process group, so a timeout kills the whole pipeline the code
    // started, not just the shell.
    const child = spawn("bash", ["-lc", frame.code], {
      cwd: frame.cwd ?? defaultCwd,
      env: { ...process.env, ...frame.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = (): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout((): void => {
      timedOut = true;
      killGroup();
    }, frame.timeoutSeconds * 1000);
    const onAbort = (): void => {
      killGroup();
      finish(null, "stopped: the daemon closed its socket");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer): void => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer): void => stderr.append(chunk));
    child.on("error", (error): void => finish(null, error.message));
    child.on("close", (code): void => finish(code));
    if (signal?.aborted) onAbort();
  });
}

/** Bounded byte sink: keeps the first `limit` bytes and notes the overflow. */
class OutputBuffer {
  readonly #chunks: Buffer[] = [];
  readonly #limit: number;
  #size = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Buffer): void {
    if (this.#size >= this.#limit) {
      this.truncated = true;

      return;
    }
    const room = this.#limit - this.#size;
    if (chunk.byteLength > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#size = this.#limit;
      this.truncated = true;

      return;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.byteLength;
  }

  text(): string {
    const value = Buffer.concat(this.#chunks).toString("utf8");

    return this.truncated ? `${value}\n[output truncated]` : value;
  }
}

function oneLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";

  return line.length > LOG_CODE_WIDTH
    ? `${line.slice(0, LOG_CODE_WIDTH)}…`
    : line;
}

/** One socket lifetime: connect, claim the sandbox, serve frames until close. */
function serveOnce(
  options: MachineDaemonOptions,
  WebSocketImpl: ReturnType<typeof resolveWebSocket>,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve): void => {
    const socket = new WebSocketImpl(
      machineSocketUrl(options.baseUrl),
      webSocketSubprotocols(options.apiKey),
    );
    // Aborts with the socket, so a command still running when it drops is killed.
    const lifetime = new AbortController();
    const onAbort = (): void => socket.close(1000, "daemon stopped");
    const send = (frame: MachineDaemonFrame): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    socket.onopen = (): void =>
      send({
        type: "hello",
        sandbox: options.sandbox,
        hostname: hostname(),
        platform: process.platform,
      });
    socket.onmessage = (event): void => {
      const frame = parseCoreFrame(event.data);
      if (frame?.type === "ready") {
        options.log(`connected as ${options.sandbox} (${frame.sandboxId})`);

        return;
      }
      if (frame?.type !== "exec") return;
      options.log(`$ ${oneLine(frame.code)}`);
      void runExec(frame, options.cwd, lifetime.signal).then((result): void => {
        options.log(
          `  exit ${result.exitCode ?? "none"} in ${result.durationMs}ms${result.timedOut ? " (timed out)" : ""}`,
        );
        send(result);
      });
    };
    socket.onclose = (event): void => {
      options.signal.removeEventListener("abort", onAbort);
      lifetime.abort();
      resolve({ code: event.code, reason: event.reason });
    };
  });
}
