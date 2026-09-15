/**
 * The "machine" provider: bash and the computer tool run on the user's own
 * computer through the WebSocket its `broods machine` daemon keeps open. Live
 * daemons are held in memory only.
 */

import { resolveBearerAuth } from "../../shared/auth.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import { logInfo, logWarn } from "../../shared/log.ts";
import {
  MACHINE_CLOSE,
  MACHINE_WEBSOCKET_PATH,
  parseDaemonFrame,
  type ComputerInput,
  type MachineComputerFrame,
  type MachineComputerResultFrame,
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
import { configString, mergeSandboxEnv, truncateText } from "./utils.ts";

// The helper bounds a desktop action; a wait or hold adds its own duration.
const COMPUTER_REPLY_MS = 30_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
// The daemon kills the process at timeoutSeconds; this covers the round trip.
const REPLY_GRACE_MS = 5_000;
// Keyed by registryKey; the last daemon to claim a record wins.
const connections = new Map<string, MachineConnection>();

type MachineReply = MachineComputerResultFrame | MachineResultFrame;

interface MachineConnection {
  computer: boolean;
  name: string;
  pending: Map<string, PendingReply>;
  socket: Bun.ServerWebSocket<MachineSocketData>;
}

export interface MachineSocketData {
  /** Unset for a bearer with no account. */
  accountId?: string;
  claimed?: boolean;
  key?: string;
}

interface PendingReply {
  reject: (error: Error) => void;
  resolve: (reply: MachineReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MachineSandboxExecutor implements SandboxExecutor {
  readonly #config: SandboxExecutorConfig;

  constructor(config: SandboxExecutorConfig) {
    this.#config = config;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const connection = connectedMachine(this.#config);
    const frame: MachineExecFrame = {
      type: "exec",
      id: crypto.randomUUID(),
      code: request.code,
      cwd: configString(this.#config.options?.cwd),
      env: mergeSandboxEnv(this.#config.envVars, request.envVars),
      timeoutSeconds: request.timeoutSeconds,
      outputLimitBytes: request.outputLimitBytes,
    };
    const reply = await sendFrame(
      connection,
      frame,
      frame.timeoutSeconds * 1000 + REPLY_GRACE_MS,
    );
    if (reply.type !== "result") {
      throw new Error(
        "machine sandbox answered an exec with a computer result",
      );
    }
    const stdout = truncateText(reply.stdout, request.outputLimitBytes);
    const stderr = truncateText(reply.stderr, request.outputLimitBytes);

    return {
      ok: reply.exitCode === 0,
      runtime: request.runtime ?? "bash",
      exitCode: reply.exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      durationMs: reply.durationMs,
      timedOut: reply.timedOut,
      truncated: reply.truncated || stdout.truncated || stderr.truncated,
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

export const machineWebSocketHandler: Bun.WebSocketHandler<MachineSocketData> =
  {
    maxPayloadLength: MAX_FRAME_BYTES,
    message: function (socket, raw): void {
      const accountId = socket.data.accountId;
      if (!accountId) {
        socket.close(
          MACHINE_CLOSE.unauthorized.code,
          MACHINE_CLOSE.unauthorized.reason,
        );

        return;
      }
      const frame = parseDaemonFrame(raw);
      // A second hello during the async claim would register this socket twice.
      if (!frame || (frame.type === "hello" && socket.data.claimed)) {
        socket.close(
          MACHINE_CLOSE.badFrame.code,
          MACHINE_CLOSE.badFrame.reason,
        );

        return;
      }
      if (frame.type !== "hello") {
        if (socket.data.key) settleReply(socket.data.key, frame);

        return;
      }
      socket.data.claimed = true;
      claimSandbox(socket, accountId, frame).catch((error: unknown): void => {
        logWarn("Machine sandbox claim failed", {
          accountId: accountId,
          sandbox: frame.sandbox,
          error: toErrorMessage(error),
        });
        socket.close(1011, "sandbox lookup failed");
      });
    },
    close: function (socket): void {
      const key = socket.data.key;
      const connection = key ? connections.get(key) : undefined;
      // A replaced socket must not tear down its successor's registration.
      if (!key || !connection || connection.socket !== socket) return;
      connections.delete(key);
      rejectPending(
        connection,
        `machine sandbox "${connection.name}" disconnected while the command was running`,
      );
      logInfo("Machine sandbox disconnected", {
        accountId: socket.data.accountId,
        sandbox: connection.name,
      });
    },
  };

export async function runMachineComputerAction(
  config: SandboxExecutorConfig,
  input: ComputerInput,
): Promise<MachineComputerResultFrame> {
  const connection = connectedMachine(config);
  if (!connection.computer) {
    throw new Error(
      `computer use is off on machine sandbox "${connection.name}". Restart it with \`broods machine ${connection.name} --computer\`.`,
    );
  }
  const frame: MachineComputerFrame = {
    ...input,
    type: "computer",
    id: crypto.randomUUID(),
  };
  const reply = await sendFrame(
    connection,
    frame,
    COMPUTER_REPLY_MS + (input.duration ?? 0) * 1000,
  );
  if (reply.type !== "computer-result") {
    throw new Error(
      "machine sandbox answered a computer action with an exec result",
    );
  }

  return reply;
}

/**
 * Upgrades even a bearer with no account, so the daemon reads a 4401 close
 * through the gateway relay instead of a bare 1006.
 */
export async function upgradeMachineSocket(
  request: Request,
  server: Bun.Server<MachineSocketData>,
): Promise<Response | undefined> {
  const auth = await resolveBearerAuth({
    authorization: request.headers.get("authorization") ?? "",
  });
  const data: MachineSocketData =
    auth && auth.kind !== "admin" ? { accountId: auth.account.accountId } : {};

  return server.upgrade(request, { data: data })
    ? undefined
    : Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
}

async function claimSandbox(
  socket: Bun.ServerWebSocket<MachineSocketData>,
  accountId: string,
  hello: MachineHelloFrame,
): Promise<void> {
  const records = await getStorage().sandboxConfigs.list(accountId);
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
  const key = registryKey(accountId, record.sandboxId);
  const previous = connections.get(key);
  if (previous) {
    rejectPending(previous, MACHINE_CLOSE.replaced.reason);
    previous.socket.close(
      MACHINE_CLOSE.replaced.code,
      MACHINE_CLOSE.replaced.reason,
    );
  }
  socket.data.key = key;
  connections.set(key, {
    computer: hello.computer === true,
    name: record.name,
    pending: new Map(),
    socket: socket,
  });
  const ready: MachineReadyFrame = {
    type: "ready",
    sandboxId: record.sandboxId,
  };
  socket.send(JSON.stringify(ready));
  logInfo("Machine sandbox connected", {
    accountId: accountId,
    sandbox: record.name,
    computer: hello.computer === true,
    host: hello.hostname,
    platform: hello.platform,
  });
}

function connectedMachine(config: SandboxExecutorConfig): MachineConnection {
  const plane = config.controlPlane;
  if (!plane?.sandboxConfigId) {
    throw new Error("machine sandbox needs a sandbox config record");
  }
  const connection = connections.get(
    registryKey(plane.accountId, plane.sandboxConfigId),
  );
  if (!connection) {
    throw new Error(
      `machine sandbox "${plane.name}" is not connected. Run \`broods machine ${plane.name}\` on that computer.`,
    );
  }

  return connection;
}

function registryKey(accountId: string, sandboxConfigId: string): string {
  return `${accountId}:${sandboxConfigId}`;
}

function rejectPending(connection: MachineConnection, reason: string): void {
  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  connection.pending.clear();
}

function sendFrame(
  connection: MachineConnection,
  frame: MachineComputerFrame | MachineExecFrame,
  timeoutMs: number,
): Promise<MachineReply> {
  return new Promise((resolve, reject): void => {
    const timer = setTimeout((): void => {
      connection.pending.delete(frame.id);
      reject(
        new Error(
          `machine sandbox did not answer within ${Math.round(timeoutMs / 1000)}s`,
        ),
      );
    }, timeoutMs);
    connection.pending.set(frame.id, {
      reject: reject,
      resolve: resolve,
      timer: timer,
    });
    connection.socket.send(JSON.stringify(frame));
  });
}

function settleReply(key: string, reply: MachineReply): void {
  const connection = connections.get(key);
  const pending = connection?.pending.get(reply.id);
  if (!connection || !pending) {
    logWarn("Machine reply for an unknown request", { id: reply.id });

    return;
  }
  clearTimeout(pending.timer);
  connection.pending.delete(reply.id);
  pending.resolve(reply);
}
