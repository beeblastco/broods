/**
 * `broods machine <sandbox>`: make this computer the sandbox behind a
 * `provider: "machine"` record. One WebSocket out to the gateway, one `bash -lc`
 * per exec frame, and a reconnect loop for everything that is not a refusal.
 *
 * The host environment is inherited on purpose. This is the user's own
 * machine, so the agent gets the same PATH, keychains and CLIs the user has.
 */

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { webSocketSubprotocols } from "../websocket.ts";
import {
  MACHINE_FATAL_CLOSE_CODES,
  machineSocketUrl,
  parseMachineServerFrame,
  type MachineExecFrame,
  type MachineHelloFrame,
  type MachineResultFrame,
} from "../machine-contracts.ts";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const LOG_CODE_WIDTH = 72;

export interface MachineDaemonOptions {
  apiKey: string;
  baseUrl: string;
  /** Working directory for an exec that names none. */
  cwd: string;
  log: (line: string) => void;
  sandbox: string;
  signal: AbortSignal;
}

type WebSocketConstructor = new (
  url: string,
  protocols?: string[],
) => WebSocket;

/**
 * Serve execs until the signal aborts. Throws when core refuses the socket
 * (bad key, unknown sandbox, replaced by another daemon), since retrying
 * those would only repeat the refusal.
 */
export async function runMachineDaemon(
  options: MachineDaemonOptions,
): Promise<void> {
  const WebSocketImpl = resolveWebSocket();
  let delayMs = RECONNECT_MIN_MS;
  while (!options.signal.aborted) {
    const startedAt = Date.now();
    const closed = await serveOnce(options, WebSocketImpl);
    if (options.signal.aborted) return;
    if (MACHINE_FATAL_CLOSE_CODES.has(closed.code)) {
      throw new Error(
        closed.reason || `core closed the socket (${closed.code})`,
      );
    }
    // A session that lasted is a healthy one: restart the backoff.
    if (Date.now() - startedAt > RECONNECT_MAX_MS) delayMs = RECONNECT_MIN_MS;
    options.log(
      `disconnected (${closed.reason || closed.code}), reconnecting in ${Math.round(delayMs / 1000)}s`,
    );
    await sleep(delayMs, options.signal);
    delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
  }
}

/** Run one exec frame on this machine and shape its outcome as a result frame. */
export function runExec(
  frame: MachineExecFrame,
  defaultCwd: string,
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
      if (failure) stderr.append(Buffer.from(`${failure}\n`));
      resolve({
        type: "result",
        id: frame.id,
        exitCode: exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Math.round(performance.now() - startedAt),
        ...(timedOut ? { timedOut: true } : {}),
        ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
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
    const timer = setTimeout((): void => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, frame.timeoutSeconds * 1000);

    child.stdout.on("data", (chunk: Buffer): void => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer): void => stderr.append(chunk));
    child.on("error", (error): void => finish(null, error.message));
    child.on("close", (code): void => finish(code));
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

function oneLine(code: string): string {
  const line = code.trim().split("\n")[0] ?? "";

  return line.length > LOG_CODE_WIDTH
    ? `${line.slice(0, LOG_CODE_WIDTH)}…`
    : line;
}

function resolveWebSocket(): WebSocketConstructor {
  const impl = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!impl) throw new Error("WebSocket is not available in this environment.");

  return impl;
}

/** One socket lifetime: connect, claim the sandbox, serve execs until close. */
function serveOnce(
  options: MachineDaemonOptions,
  WebSocketImpl: WebSocketConstructor,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve): void => {
    const socket = new WebSocketImpl(
      machineSocketUrl(options.baseUrl),
      webSocketSubprotocols(options.apiKey),
    );
    const onAbort = (): void => socket.close(1000, "daemon stopped");
    options.signal.addEventListener("abort", onAbort, { once: true });

    socket.onopen = (): void => {
      const hello: MachineHelloFrame = {
        type: "hello",
        sandbox: options.sandbox,
        hostname: hostname(),
        platform: process.platform,
      };
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (event): void => {
      const frame = parseMachineServerFrame(event.data);
      if (!frame) return;
      if (frame.type === "ready") {
        options.log(`connected as ${options.sandbox} (${frame.sandboxId})`);

        return;
      }
      options.log(`$ ${oneLine(frame.code)}`);
      void runExec(frame, options.cwd).then((result): void => {
        options.log(
          `  exit ${result.exitCode ?? "none"} in ${result.durationMs}ms${result.timedOut ? " (timed out)" : ""}`,
        );
        if (socket.readyState === socket.OPEN)
          socket.send(JSON.stringify(result));
      });
    };
    socket.onerror = (): void => {
      // The close event that follows carries the code; nothing to do here.
    };
    socket.onclose = (event): void => {
      options.signal.removeEventListener("abort", onAbort);
      resolve({ code: event.code, reason: event.reason });
    };
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve): void => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
