import { spawn } from "node:child_process";
import { statfsSync } from "node:fs";
import { availableParallelism, homedir, hostname, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import {
  MACHINE_CLOSE,
  machineSocketUrl,
  parseCoreFrame,
  type MachineComputerFrame,
  type MachineDaemonFrame,
  type MachineExecFrame,
  type MachineHelloFrame,
  type MachineMcpCallFrame,
  type MachineMcpListFrame,
  type MachineMcpResultFrame,
  type MachineMcpToolsFrame,
  type MachineResultFrame,
} from "../../../../apps/core/src/shared/machine-socket.ts";
import {
  reconnectDelay,
  resolveWebSocket,
  StageSessionRefusedError,
} from "../observability-client.ts";
import { agentEnv } from "../runtime-config.ts";
import { webSocketSubprotocols } from "../websocket.ts";
import type { DesktopDriver } from "./desktop.ts";
import type { McpHost } from "./mcp-host.ts";

// Refusals a reconnect would only repeat.
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  MACHINE_CLOSE.occupied.code,
  MACHINE_CLOSE.replaced.code,
  MACHINE_CLOSE.unauthorized.code,
  MACHINE_CLOSE.unknownSandbox.code,
]);
const LOG_CODE_WIDTH = 72;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;

export interface MachineDaemonOptions {
  baseUrl: string;
  computer?: boolean;
  /** Called per connection and per refresh; each call mints a fresh stage ticket. */
  credential: () => Promise<string>;
  cwd: string;
  force?: boolean;
  log: (line: string) => void;
  mcpFile?: string;
  sandbox: string;
  signal: AbortSignal;
}

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

    // Its own process group, so a kill reaches every process the command started.
    const child = spawn("bash", ["-lc", frame.code], {
      cwd: frame.cwd ?? defaultCwd,
      env: { ...agentEnv(), ...frame.env },
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

export async function runMachineDaemon(
  options: MachineDaemonOptions,
): Promise<void> {
  const WebSocketImpl = resolveWebSocket();
  // Lets only this process reclaim its record after a network drop; a restart is a new daemon.
  const instance = crypto.randomUUID();
  // MCP first: a bad file fails before the desktop helper starts.
  const mcp = options.mcpFile
    ? await openMcpHost(options.mcpFile, options.log)
    : null;
  const desktop = options.computer ? await openDesktop(options.log) : null;
  let delayMs = RECONNECT_MIN_MS;
  try {
    while (!options.signal.aborted) {
      const startedAt = Date.now();
      let token: string;
      try {
        token = await options.credential();
      } catch (error) {
        if (error instanceof StageSessionRefusedError) throw error;
        options.log(
          `stage session unavailable (${error instanceof Error ? error.message : String(error)}), retrying in ${Math.round(delayMs / 1000)}s`,
        );
        await reconnectDelay(delayMs, options.signal);
        delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
        continue;
      }
      const closed = await serveOnce(
        options,
        token,
        instance,
        WebSocketImpl,
        desktop,
        mcp,
      );
      if (options.signal.aborted) return;
      if (FATAL_CLOSE_CODES.has(closed.code)) {
        throw new Error(
          closed.reason || `core closed the socket (${closed.code})`,
        );
      }
      if (Date.now() - startedAt > RECONNECT_MAX_MS) delayMs = RECONNECT_MIN_MS;
      options.log(
        `disconnected (${closed.reason || closed.code}), reconnecting in ${Math.round(delayMs / 1000)}s`,
      );
      await reconnectDelay(delayMs, options.signal);
      delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
    }
  } finally {
    desktop?.stop();
    await mcp?.stop();
  }
}

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

function describeComputerFrame(frame: MachineComputerFrame): string {
  const parts: string[] = [frame.action];
  if (frame.coordinate) parts.push(`at ${frame.coordinate.join(",")}`);
  if (frame.text !== undefined) parts.push(JSON.stringify(oneLine(frame.text)));
  if (frame.region) parts.push(`region ${frame.region.join(",")}`);

  return parts.join(" ");
}

function hardwareSpecs(): MachineHelloFrame["specs"] {
  const storageGb = homeDiskGb();

  return {
    vcpu: availableParallelism(),
    memoryMb: Math.round(totalmem() / 1024 ** 2),
    ...(storageGb ? { storageGb: storageGb } : {}),
  };
}

function homeDiskGb(): number | undefined {
  try {
    const disk = statfsSync(homedir());

    return Math.round((disk.blocks * disk.bsize) / 1024 ** 3);
  } catch {
    return undefined;
  }
}

function oneLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";

  return line.length > LOG_CODE_WIDTH
    ? `${line.slice(0, LOG_CODE_WIDTH)}…`
    : line;
}

// Started before the first connect, so a missing compiler or grant surfaces right away.
async function openDesktop(
  log: (line: string) => void,
): Promise<DesktopDriver> {
  const { startDesktop } = await import("./desktop.ts");
  const { display, driver, permissions } = await startDesktop(false);
  log(`computer use on, ${display.width}x${display.height} screenshots`);
  if (!permissions.screenRecording || !permissions.accessibility) {
    log(
      "  screen recording or accessibility is missing, run `broods machine --doctor --request`",
    );
  }

  return driver;
}

async function openMcpHost(
  file: string,
  log: (line: string) => void,
): Promise<McpHost> {
  const { McpHost: Host, readMcpServersFile } = await import("./mcp-host.ts");
  const host = new Host(readMcpServersFile(file), log);
  log(`mcp servers from ${file}: ${host.names().join(", ")}`);

  return host;
}

async function serveMcp(
  frame: MachineMcpCallFrame | MachineMcpListFrame,
  host: McpHost,
  log: (line: string) => void,
): Promise<MachineMcpResultFrame | MachineMcpToolsFrame> {
  try {
    if (frame.type === "mcp-list") {
      const tools = await host.listTools(frame.server);
      log(`  mcp ${frame.server}: ${tools.length} tools`);

      return { type: "mcp-tools", id: frame.id, tools: tools };
    }
    log(`  mcp ${frame.server}.${frame.tool}`);
    const result = await host.callTool(frame.server, frame.tool, frame.args);

    return { type: "mcp-result", id: frame.id, result: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`  mcp ${frame.server}: ${message}`);

    return {
      type: frame.type === "mcp-call" ? "mcp-result" : "mcp-tools",
      id: frame.id,
      error: message,
    };
  }
}

function serveOnce(
  options: MachineDaemonOptions,
  token: string,
  instance: string,
  WebSocketImpl: ReturnType<typeof resolveWebSocket>,
  desktop: DesktopDriver | null,
  mcp: McpHost | null,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve): void => {
    const socket = new WebSocketImpl(
      machineSocketUrl(options.baseUrl),
      webSocketSubprotocols(token),
    );
    // Aborts on close: a result that can no longer be sent is not worth waiting for.
    const lifetime = new AbortController();
    const onAbort = (): void => socket.close(1000, "daemon stopped");
    const send = (frame: MachineDaemonFrame): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };
    // Core closes a ticket's socket at expiry, killing running commands, so a fresh ticket goes
    // in at half the time left, then half of what remains, until core sends a new deadline.
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const refreshBefore = (expiresAt: number): void => {
      clearTimeout(refresh);
      if (lifetime.signal.aborted) return;
      refresh = setTimeout(
        (): void => {
          void options
            .credential()
            .then(
              (fresh): void => send({ type: "credential", token: fresh }),
              (error: unknown): void =>
                options.log(
                  `credential refresh failed (${error instanceof Error ? error.message : String(error)}), retrying`,
                ),
            )
            .finally((): void => refreshBefore(expiresAt));
        },
        Math.max((expiresAt - Date.now()) / 2, RECONNECT_MIN_MS),
      );
    };
    const finish = (code: number, reason: string): void => {
      options.signal.removeEventListener("abort", onAbort);
      clearTimeout(refresh);
      lifetime.abort();
      resolve({ code: code, reason: reason });
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    socket.onopen = (): void =>
      send({
        type: "hello",
        sandbox: options.sandbox,
        hostname: hostname(),
        platform: process.platform,
        computer: desktop !== null,
        mcp: mcp?.names(),
        instance: instance,
        force: options.force,
        specs: hardwareSpecs(),
      });
    socket.onmessage = (event): void => {
      const frame = parseCoreFrame(event.data);
      if (frame?.type === "ready") {
        // A later ready only acknowledges a fresh ticket.
        if (refresh === undefined) {
          options.log(`connected as ${options.sandbox} (${frame.sandboxId})`);
        }
        if (frame.expiresInMs !== undefined) {
          refreshBefore(Date.now() + frame.expiresInMs);
        }

        return;
      }
      if (frame?.type === "computer" && desktop) {
        options.log(`  ${describeComputerFrame(frame)}`);
        void desktop.run(frame).then((result): void => {
          if (result.error) options.log(`  error: ${result.error}`);
          send(result);
        });

        return;
      }
      if ((frame?.type === "mcp-call" || frame?.type === "mcp-list") && mcp) {
        void serveMcp(frame, mcp, options.log).then(send);

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
    // Node fires only `error`, never `close`, for a connection that fails.
    socket.onerror = (): void => finish(1006, "connection failed");
    socket.onclose = (event): void => finish(event.code, event.reason);
  });
}
