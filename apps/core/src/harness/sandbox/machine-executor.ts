/**
 * The "machine" provider: the sandbox is the user's own computer.
 *
 * The computer runs `broods machine <sandbox>` (packages/broods), which opens
 * one WebSocket out through the gateway to `MACHINE_WEBSOCKET_PATH` here and
 * claims a sandbox record by name. Core keeps that socket in memory, keyed by
 * account + sandbox record, and `run` is a request/reply over it: the bash
 * `code` string goes out, stdout/stderr/exit come back. Nothing is persisted
 * and there is nothing to reserve or release; a laptop is always "on".
 */

import { resolveBearerAuth } from "../../shared/auth.ts";
import { logInfo, logWarn } from "../../shared/log.ts";
import {
  MACHINE_CLOSE,
  MACHINE_WEBSOCKET_PATH,
  parseMachineFrame,
  type MachineExecFrame,
  type MachineHelloFrame,
  type MachineReadyFrame,
  type MachineResultFrame,
} from "../../shared/machine-socket.ts";
import { getStorage } from "../../shared/storage.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import { mergeSandboxEnv, truncateText } from "./utils.ts";

// The daemon kills the process at timeoutSeconds; this covers the round trip.
const REPLY_GRACE_MS = 5_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Live daemon sockets by `${accountId}:${sandboxConfigId}`; last daemon wins. */
const connections = new Map<string, MachineConnection>();

export interface MachineSocketData {
  accountId: string;
  /** Set the moment a `hello` arrives, so a second one is a bad frame. */
  claimed?: boolean;
  /** Set once `hello` claimed a sandbox record. */
  key?: string;
  sandboxName?: string;
}

interface MachineConnection {
  pending: Map<string, PendingExec>;
  socket: Bun.ServerWebSocket<MachineSocketData>;
}

interface PendingExec {
  reject: (error: Error) => void;
  resolve: (result: MachineResultFrame) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MachineSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const name = this.#config.controlPlane?.name ?? "machine";
    const connection = connections.get(registryKeyFor(this.#config));
    if (!connection) {
      throw new Error(
        `machine sandbox "${name}" is not connected. Run \`broods machine ${name}\` on that computer.`,
      );
    }
    const cwd = configCwd(this.#config);
    const frame: MachineExecFrame = {
      type: "exec",
      id: crypto.randomUUID(),
      code: request.code,
      ...(cwd ? { cwd: cwd } : {}),
      env: mergeSandboxEnv(this.#config.envVars, request.envVars),
      timeoutSeconds: request.timeoutSeconds,
      outputLimitBytes: request.outputLimitBytes,
    };
    const result = await sendExec(connection, frame);
    const stdout = truncateText(result.stdout, request.outputLimitBytes);
    const stderr = truncateText(result.stderr, request.outputLimitBytes);

    return {
      ok: result.exitCode === 0,
      runtime: request.runtime ?? "bash",
      exitCode: result.exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      durationMs: result.durationMs,
      timedOut: result.timedOut === true,
      truncated:
        result.truncated === true || stdout.truncated || stderr.truncated,
      provider: "machine",
    };
  }
}

export function isMachineUpgrade(request: Request): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    new URL(request.url).pathname === MACHINE_WEBSOCKET_PATH
  );
}

/** Bun.serve `websocket` handler for the daemon socket. */
export const machineWebSocketHandler: Bun.WebSocketHandler<MachineSocketData> =
  {
    maxPayloadLength: MAX_FRAME_BYTES,
    message: function (socket, raw): void {
      const frame = parseMachineFrame(raw);
      if (!frame) {
        socket.close(
          MACHINE_CLOSE.badFrame.code,
          MACHINE_CLOSE.badFrame.reason,
        );

        return;
      }
      if (frame.type === "hello") {
        // The claim is async; the flag closes the window for a second hello
        // that would register this socket twice or under another record.
        if (socket.data.claimed) {
          socket.close(
            MACHINE_CLOSE.badFrame.code,
            MACHINE_CLOSE.badFrame.reason,
          );

          return;
        }
        socket.data.claimed = true;
        claimSandbox(socket, frame).catch((error: unknown): void => {
          logWarn("Machine sandbox claim failed", {
            accountId: socket.data.accountId,
            sandbox: frame.sandbox,
            error: error instanceof Error ? error.message : String(error),
          });
          socket.close(1011, "sandbox lookup failed");
        });

        return;
      }
      if (frame.type === "result" && socket.data.key) {
        settleExec(socket.data.key, frame);
      }
    },
    close: function (socket): void {
      const key = socket.data.key;
      if (!key) return;
      const connection = connections.get(key);
      // A replaced socket must not tear down its successor's registration.
      if (!connection || connection.socket !== socket) return;
      connections.delete(key);
      rejectPending(
        connection,
        `machine sandbox "${socket.data.sandboxName}" disconnected while the command was running`,
      );
      logInfo("Machine sandbox disconnected", {
        accountId: socket.data.accountId,
        sandbox: socket.data.sandboxName,
      });
    },
  };

/**
 * Authenticate the daemon and upgrade. A runtime key or the account secret
 * both name one account; the sandbox record is claimed by the first frame.
 */
export async function upgradeMachineSocket(
  request: Request,
  server: Bun.Server<MachineSocketData>,
): Promise<Response | undefined> {
  const authorization = request.headers.get("authorization") ?? "";
  const auth = await resolveBearerAuth({ authorization: authorization });
  if (!auth || auth.kind === "admin") {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const data: MachineSocketData = { accountId: auth.account.accountId };
  const upgraded = server.upgrade(request, { data: data });

  return upgraded
    ? undefined
    : Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
}

async function claimSandbox(
  socket: Bun.ServerWebSocket<MachineSocketData>,
  hello: MachineHelloFrame,
): Promise<void> {
  const records = await getStorage().sandboxConfigs.list(socket.data.accountId);
  const record = records.find(
    (entry) =>
      entry.name === hello.sandbox && entry.config.provider === "machine",
  );
  if (!record) {
    socket.close(
      MACHINE_CLOSE.unknownSandbox.code,
      MACHINE_CLOSE.unknownSandbox.reason,
    );

    return;
  }
  const key = registryKey(socket.data.accountId, record.sandboxId);
  const previous = connections.get(key);
  if (previous && previous.socket !== socket) {
    // Last one wins: restarting the daemon must not need the old one gone first.
    rejectPending(previous, MACHINE_CLOSE.replaced.reason);
    previous.socket.close(
      MACHINE_CLOSE.replaced.code,
      MACHINE_CLOSE.replaced.reason,
    );
  }
  socket.data.key = key;
  socket.data.sandboxName = record.name;
  connections.set(key, { socket: socket, pending: new Map() });
  const ready: MachineReadyFrame = {
    type: "ready",
    sandboxId: record.sandboxId,
  };
  socket.send(JSON.stringify(ready));
  logInfo("Machine sandbox connected", {
    accountId: socket.data.accountId,
    sandbox: record.name,
    host: hello.hostname,
    platform: hello.platform,
  });
}

function configCwd(config: SandboxExecutorConfig): string | undefined {
  const cwd = config.options?.cwd;

  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : undefined;
}

function registryKey(accountId: string, sandboxConfigId: string): string {
  return `${accountId}:${sandboxConfigId}`;
}

function registryKeyFor(config: SandboxExecutorConfig): string {
  const plane = config.controlPlane;
  if (!plane?.sandboxConfigId) {
    throw new Error(
      "machine sandbox needs its config record id; a synthetic config cannot reach a computer",
    );
  }

  return registryKey(plane.accountId, plane.sandboxConfigId);
}

function rejectPending(connection: MachineConnection, reason: string): void {
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  connection.pending.clear();
}

function sendExec(
  connection: MachineConnection,
  frame: MachineExecFrame,
): Promise<MachineResultFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        connection.pending.delete(frame.id);
        reject(
          new Error(
            `machine sandbox did not answer within ${frame.timeoutSeconds}s`,
          ),
        );
      },
      frame.timeoutSeconds * 1000 + REPLY_GRACE_MS,
    );
    connection.pending.set(frame.id, {
      resolve: resolve,
      reject: reject,
      timer: timer,
    });
    connection.socket.send(JSON.stringify(frame));
  });
}

function settleExec(key: string, result: MachineResultFrame): void {
  const connection = connections.get(key);
  const pending = connection?.pending.get(result.id);
  if (!connection || !pending) {
    logWarn("Machine result for an unknown exec", { id: result.id });

    return;
  }
  clearTimeout(pending.timer);
  connection.pending.delete(result.id);
  pending.resolve(result);
}
