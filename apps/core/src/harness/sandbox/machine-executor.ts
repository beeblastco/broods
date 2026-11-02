import {
  authorize,
  rolePrincipal,
  type ApiResource,
  type RolePrincipal,
} from "@broods/convex/model/apiAuthorization";
import { resolveBearerAuth } from "../../shared/auth.ts";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import { logInfo, logWarn } from "../../shared/log.ts";
import {
  MACHINE_CLOSE,
  MACHINE_MAX_FRAME_BYTES,
  MACHINE_WEBSOCKET_PATH,
  occupiedReason,
  parseDaemonFrame,
  type ComputerInput,
  type MachineComputerFrame,
  type MachineComputerResultFrame,
  type MachineExecFrame,
  type MachineHelloFrame,
  type MachineMcpCallFrame,
  type MachineMcpListFrame,
  type MachineMcpResultFrame,
  type MachineMcpToolsFrame,
  type MachineReadyFrame,
  type MachineResultFrame,
} from "../../shared/machine-socket.ts";
import { getStorage, type MachineConnectionRef } from "../../shared/storage.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import { configString, mergeSandboxEnv, truncateText } from "./utils.ts";

const COMPUTER_REPLY_MS = 30_000;
const HEARTBEAT_MS = 60_000;
// Codex's per-tool default; a local server slower than that is hung.
const MCP_REPLY_MS = 60_000;
const REPLY_GRACE_MS = 5_000;
// Live daemon sockets exist only here; Convex just mirrors them for the dashboard.
const connections = new Map<string, MachineConnection>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

type MachineReply =
  | MachineComputerResultFrame
  | MachineMcpResultFrame
  | MachineMcpToolsFrame
  | MachineResultFrame;

type MachineRequest =
  | MachineComputerFrame
  | MachineExecFrame
  | MachineMcpCallFrame
  | MachineMcpListFrame;

interface MachineConnection {
  computer: boolean;
  hostname?: string;
  instance?: string;
  mcp: ReadonlySet<string>;
  name: string;
  pending: Map<string, PendingReply>;
  ref: MachineConnectionRef;
  socket: Bun.ServerWebSocket<MachineSocketData>;
}

export interface MachineSocketData {
  accountId?: string;
  authorization?: string;
  claimed?: boolean;
  closed?: boolean;
  expiresAt?: number;
  expiry?: ReturnType<typeof setTimeout>;
  key?: string;
  role?: RolePrincipal;
  claim?: ApiResource;
  stage?: { projectId: string; stageId: string };
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
      env: mergeSandboxEnv(
        this.#config.envVars,
        request.envVars,
        request.principal,
      ),
      timeoutSeconds: request.timeoutSeconds,
      outputLimitBytes: request.outputLimitBytes,
    };
    const reply = await sendFrame(
      connection,
      frame,
      frame.timeoutSeconds * 1000 + REPLY_GRACE_MS,
    );
    if (reply.type !== "result") {
      throw new Error(`machine sandbox answered an exec with ${reply.type}`);
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
    maxPayloadLength: MACHINE_MAX_FRAME_BYTES,
    open: armExpiry,
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
      if (frame.type === "credential") {
        void refreshCredential(socket, frame.token);

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
      socket.data.closed = true;
      clearTimeout(socket.data.expiry);
      const key = socket.data.key;
      const connection = key ? connections.get(key) : undefined;
      // A replaced socket must not tear down its successor's registration.
      if (!key || !connection || connection.socket !== socket) return;
      connections.delete(key);
      mirrorConnection(() =>
        getStorage().machineConnections.disconnected(connection.ref),
      );
      if (connections.size === 0) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
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
      `machine sandbox answered a computer action with ${reply.type}`,
    );
  }

  return reply;
}

export async function runMachineMcpCall(
  record: McpRecord,
  tool: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const reply = await sendFrame(
    machineServingMcp(record),
    {
      type: "mcp-call",
      id: crypto.randomUUID(),
      server: record.name,
      tool: tool,
      args: args,
    },
    MCP_REPLY_MS,
  );
  if (reply.type !== "mcp-result") {
    throw new Error(`machine sandbox answered an MCP call with ${reply.type}`);
  }
  if (!reply.result) {
    throw new Error(reply.error ?? "machine sandbox returned no MCP result");
  }

  return reply.result;
}

export async function runMachineMcpList(
  record: McpRecord,
): Promise<Record<string, unknown>[]> {
  const reply = await sendFrame(
    machineServingMcp(record),
    { type: "mcp-list", id: crypto.randomUUID(), server: record.name },
    MCP_REPLY_MS,
  );
  if (reply.type !== "mcp-tools") {
    throw new Error(
      `machine sandbox answered an MCP listing with ${reply.type}`,
    );
  }
  if (!reply.tools) {
    throw new Error(reply.error ?? "machine sandbox returned no MCP listing");
  }

  return reply.tools;
}

// Upgrades even a bearer with no account, so the daemon reads a 4401 close, not a bare 1006.
export async function upgradeMachineSocket(
  request: Request,
  server: Bun.Server<MachineSocketData>,
): Promise<Response | undefined> {
  const auth = await resolveBearerAuth({
    authorization: request.headers.get("authorization") ?? "",
  });
  // A claim gets every exec's env secrets: the frontend runtime key and a ticket without
  // sandboxWrite are refused, and each heartbeat re-resolves the bearer to drop a revoked one.
  const authorization = request.headers.get("authorization") ?? "";
  let data: MachineSocketData = {};
  if (auth?.kind === "account") {
    data = { accountId: auth.account.accountId, authorization: authorization };
  } else if (auth?.kind === "role") {
    const { projectId, stageId } = auth.role;
    data = {
      accountId: auth.account.accountId,
      authorization: authorization,
      role: auth.role,
      ...(projectId && stageId
        ? { stage: { projectId: projectId, stageId: stageId } }
        : {}),
    };
  } else if (
    auth?.kind === "deployment" &&
    auth.stageTicket?.sandboxWrite === true
  ) {
    data = {
      accountId: auth.account.accountId,
      authorization: authorization,
      expiresAt: auth.stageTicket.expiresAt,
      stage: {
        projectId: auth.stageTicket.projectId,
        stageId: auth.stageTicket.stageId,
      },
    };
  }

  return server.upgrade(request, { data: data })
    ? undefined
    : Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
}

function armExpiry(socket: Bun.ServerWebSocket<MachineSocketData>): void {
  const expiresAt = socket.data.expiresAt;
  if (expiresAt === undefined) return;
  clearTimeout(socket.data.expiry);
  socket.data.expiry = setTimeout(
    (): void =>
      socket.close(MACHINE_CLOSE.expired.code, MACHINE_CLOSE.expired.reason),
    expiresAt - Date.now(),
  );
}

async function claimSandbox(
  socket: Bun.ServerWebSocket<MachineSocketData>,
  accountId: string,
  hello: MachineHelloFrame,
): Promise<void> {
  const stage = socket.data.stage;
  const named = (await getStorage().sandboxConfigs.list(accountId)).filter(
    (entry) =>
      entry.name === hello.sandbox && entry.config.provider === "machine",
  );
  // Closed during the lookup: registering it now would leave a dead holder refusing the next one.
  if (socket.data.closed) return;
  // A ticket claims its own stage's record or an account-level one, never another stage's.
  const record = stage
    ? (named.find(
        (entry) =>
          entry.projectId === stage.projectId &&
          entry.stageId === stage.stageId,
      ) ??
      named.find(
        (entry) => entry.projectId === undefined && entry.stageId === undefined,
      ))
    : named[0];
  // Checked here, not at upgrade: the sandbox name only arrives in the hello.
  const claim: ApiResource | undefined = record && {
    type: "sandboxes",
    id: record.sandboxId,
    projectId: record.projectId,
    stageId: record.stageId,
  };
  const denied =
    claim !== undefined &&
    socket.data.role !== undefined &&
    !authorize(rolePrincipal(socket.data.role), "sandboxes:write", claim).allow;
  if (denied) {
    logWarn("Machine sandbox claim refused", {
      accountId: accountId,
      sandbox: hello.sandbox,
      roleId: socket.data.role?.roleId,
      host: hello.hostname,
    });
  }
  if (!record || denied) {
    socket.close(
      MACHINE_CLOSE.unknownSandbox.code,
      MACHINE_CLOSE.unknownSandbox.reason,
    );

    return;
  }
  const key = registryKey(accountId, record.sandboxId);
  const previous = connections.get(key);
  // Only the same daemon instance reclaims silently; any other needs --force.
  if (
    previous &&
    hello.force !== true &&
    !(hello.instance && hello.instance === previous.instance)
  ) {
    logWarn("Machine sandbox claim refused", {
      accountId: accountId,
      sandbox: record.name,
      holder: previous.hostname,
      host: hello.hostname,
    });
    socket.close(
      MACHINE_CLOSE.occupied.code,
      occupiedReason(previous.hostname),
    );

    return;
  }
  if (previous) {
    rejectPending(previous, MACHINE_CLOSE.replaced.reason);
    previous.socket.close(
      MACHINE_CLOSE.replaced.code,
      MACHINE_CLOSE.replaced.reason,
    );
  }
  socket.data.key = key;
  socket.data.claim = claim;
  const ref: MachineConnectionRef = {
    accountId: accountId,
    connectionId: crypto.randomUUID(),
    sandboxConfigId: record.sandboxId,
  };
  connections.set(key, {
    computer: hello.computer === true,
    ...(hello.hostname ? { hostname: hello.hostname } : {}),
    ...(hello.instance ? { instance: hello.instance } : {}),
    mcp: new Set(hello.mcp),
    name: record.name,
    pending: new Map(),
    ref: ref,
    socket: socket,
  });
  sendReady(socket, record.sandboxId);
  mirrorConnection(() =>
    getStorage().machineConnections.connected({
      ...ref,
      computer: hello.computer === true,
      hostname: hello.hostname,
      mcp: hello.mcp ?? [],
      platform: hello.platform,
      specs: hello.specs,
    }),
  );
  heartbeat ??= setInterval(sendHeartbeats, HEARTBEAT_MS);
  logInfo("Machine sandbox connected", {
    accountId: accountId,
    sandbox: record.name,
    computer: hello.computer === true,
    mcp: hello.mcp,
    host: hello.hostname,
    platform: hello.platform,
  });
}

export function isMachineConnected(config: SandboxExecutorConfig): boolean {
  const plane = config.controlPlane;

  return Boolean(
    plane?.sandboxConfigId &&
    connections.has(registryKey(plane.accountId, plane.sandboxConfigId)),
  );
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

function machineServingMcp(record: McpRecord): MachineConnection {
  const sandbox = record.sandbox ?? "";
  const connection = [...connections.values()].find(
    (entry) =>
      entry.socket.data.accountId === record.accountId &&
      entry.name === sandbox,
  );
  if (!connection) {
    throw new Error(
      `machine sandbox "${sandbox}" is not connected. Run \`broods machine ${sandbox} --mcp <file>\` on that computer.`,
    );
  }
  if (!connection.mcp.has(record.name)) {
    throw new Error(
      `machine sandbox "${sandbox}" does not serve MCP server "${record.name}". Add it under mcpServers in its --mcp file.`,
    );
  }

  return connection;
}

function mirrorConnection(write: () => Promise<void>): void {
  Promise.resolve()
    .then(write)
    .catch((error: unknown): void => {
      logWarn("Machine connection mirror failed", {
        error: toErrorMessage(error),
      });
    });
}

async function refreshCredential(
  socket: Bun.ServerWebSocket<MachineSocketData>,
  token: string,
): Promise<void> {
  const authorization = `Bearer ${token}`;
  let auth: Awaited<ReturnType<typeof resolveBearerAuth>>;
  try {
    auth = await resolveBearerAuth({ authorization: authorization });
  } catch (error: unknown) {
    logWarn("Machine sandbox credential refresh failed", {
      accountId: socket.data.accountId,
      error: toErrorMessage(error),
    });

    return;
  }
  if (socket.data.closed) return;
  const ticket =
    auth?.kind === "deployment" &&
    auth.account.accountId === socket.data.accountId
      ? auth.stageTicket
      : undefined;
  const stage = socket.data.stage;
  if (
    socket.data.expiresAt === undefined ||
    ticket?.sandboxWrite !== true ||
    ticket.projectId !== stage?.projectId ||
    ticket.stageId !== stage?.stageId
  ) {
    logWarn("Machine sandbox credential refresh refused", {
      accountId: socket.data.accountId,
    });
    socket.close(
      MACHINE_CLOSE.unauthorized.code,
      MACHINE_CLOSE.unauthorized.reason,
    );

    return;
  }
  // Two refreshes can resolve out of order; the older ticket never wins.
  if (ticket.expiresAt <= socket.data.expiresAt) return;
  socket.data.authorization = authorization;
  socket.data.expiresAt = ticket.expiresAt;
  armExpiry(socket);
  const connection = socket.data.key
    ? connections.get(socket.data.key)
    : undefined;
  if (connection?.socket === socket) {
    sendReady(socket, connection.ref.sandboxConfigId);
  }
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
  frame: MachineRequest,
  timeoutMs: number,
): Promise<MachineReply> {
  return new Promise((resolve, reject): void => {
    // The expiry timer runs late under load: never send a frame past the credential's deadline.
    const expiresAt = connection.socket.data.expiresAt;
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      connection.socket.close(
        MACHINE_CLOSE.expired.code,
        MACHINE_CLOSE.expired.reason,
      );
      reject(
        new Error(
          `machine sandbox "${connection.name}" is reconnecting with a fresh credential`,
        ),
      );

      return;
    }
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

function sendHeartbeats(): void {
  for (const connection of connections.values()) {
    mirrorConnection(() =>
      getStorage().machineConnections.seen(connection.ref),
    );
    void revalidate(connection.socket);
  }
}

async function revalidate(
  socket: Bun.ServerWebSocket<MachineSocketData>,
): Promise<void> {
  const authorization = socket.data.authorization ?? "";
  let auth: Awaited<ReturnType<typeof resolveBearerAuth>>;
  try {
    auth = await resolveBearerAuth({ authorization: authorization });
  } catch (error: unknown) {
    logWarn("Machine sandbox revalidation failed", {
      accountId: socket.data.accountId,
      error: toErrorMessage(error),
    });

    return;
  }
  // A refresh that landed meanwhile is the bearer to judge now, not this one.
  if (socket.data.closed || socket.data.authorization !== authorization) {
    return;
  }
  const claim = socket.data.claim;
  if (
    auth &&
    auth.kind !== "admin" &&
    auth.account.accountId === socket.data.accountId &&
    (auth.kind !== "role" ||
      claim === undefined ||
      authorize(rolePrincipal(auth.role), "sandboxes:write", claim).allow)
  )
    return;
  const expiresAt = socket.data.expiresAt;
  // Closing as expired makes the daemon reconnect with a fresh ticket instead of stopping.
  const close =
    expiresAt !== undefined && expiresAt <= Date.now()
      ? MACHINE_CLOSE.expired
      : MACHINE_CLOSE.unauthorized;
  socket.close(close.code, close.reason);
}

function sendReady(
  socket: Bun.ServerWebSocket<MachineSocketData>,
  sandboxId: string,
): void {
  const expiresAt = socket.data.expiresAt;
  const ready: MachineReadyFrame = {
    type: "ready",
    sandboxId: sandboxId,
    ...(expiresAt === undefined ? {} : { expiresInMs: expiresAt - Date.now() }),
  };
  socket.send(JSON.stringify(ready));
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
