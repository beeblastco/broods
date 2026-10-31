/**
 * The "machine" provider: bash, the computer tool and local MCP servers run on
 * the user's own computer through the WebSocket its `broods machine` daemon
 * keeps open. A `scope: "user"` machine is instead one browser per end user:
 * each user's extension holds its own socket, opened with a `bbt_` ticket the
 * customer's backend signed, and serves only the browser tool for runs of
 * that same user. Live sockets are held in memory; each connection is
 * mirrored to Convex for the dashboard.
 */

import {
  authorize,
  rolePrincipal,
  type ApiResource,
  type RolePrincipal,
} from "@broods/convex/model/apiAuthorization";
import {
  openBrowserTicket,
  type BrowserTicket,
} from "@broods/convex/model/browserTicket";
import {
  browserHostAllowed,
  browserMachineScope,
  type BrowserMachineScope,
} from "@broods/convex/model/sandboxRules";
import { extractBearerToken, resolveBearerAuth } from "../../shared/auth.ts";
import { decryptAccountBlob } from "../../shared/convex/account-keys.ts";
import type { McpRecord } from "../../shared/domain/mcp.ts";
import type { SandboxConfigRecord } from "../../shared/domain/sandbox-config.ts";
import { toErrorMessage } from "../../shared/errors.ts";
import { logInfo, logWarn } from "../../shared/log.ts";
import {
  browserAction,
  MACHINE_CLOSE,
  MACHINE_MAX_FRAME_BYTES,
  MACHINE_WEBSOCKET_PATH,
  matchBrowserSocketPath,
  occupiedReason,
  parseDaemonFrame,
  type BrowserAction,
  type BrowserInput,
  type ComputerInput,
  type MachineBrowserFrame,
  type MachineBrowserResultFrame,
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
import {
  getStorage,
  type MachineConnectionRef,
  type SealedAgentDeployment,
} from "../../shared/storage.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types.ts";
import { configString, mergeSandboxEnv, truncateText } from "./utils.ts";

// The page read or acted on before the extension answers; a slow page load counts.
const BROWSER_REPLY_MS = 30_000;
// Per end user and sandbox, so one run cannot flood a person's browser.
const BROWSER_ACTIONS_PER_SECOND = 20;
// Base64 of a screenshot, kept well under the 4 MB frame and what a model takes.
const BROWSER_MAX_IMAGE_CHARS = 3 * 1024 * 1024;
const BROWSER_MAX_TEXT_BYTES = 256 * 1024;
const BROWSER_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CHROME_EXTENSION_ORIGIN = "chrome-extension://";
// The helper bounds a desktop action; a wait or hold adds its own duration.
const COMPUTER_REPLY_MS = 30_000;
// The dashboard reads a computer as offline once its heartbeat goes quiet.
const HEARTBEAT_MS = 60_000;
// Codex's per-tool default; a local server slower than that is hung.
const MCP_REPLY_MS = 60_000;
// The daemon kills the process at timeoutSeconds; this covers the round trip.
const REPLY_GRACE_MS = 5_000;
// Keyed by registryKey; a record's daemon holds it until it disconnects, reconnects
// with the same instance, or is taken over with --force. A browser holds
// browserKey: its user's newer socket always replaces it.
const connections = new Map<string, MachineConnection>();
// `stageId:jti` of every ticket that opened a socket, until it expires: a
// ticket copied out of a log cannot open a second socket and push the real
// one out. In memory, because core runs one replica.
const spentTickets = new Map<string, number>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

type MachineReply =
  | MachineBrowserResultFrame
  | MachineComputerResultFrame
  | MachineMcpResultFrame
  | MachineMcpToolsFrame
  | MachineResultFrame;

type MachineRequest =
  | MachineBrowserFrame
  | MachineComputerFrame
  | MachineExecFrame
  | MachineMcpCallFrame
  | MachineMcpListFrame;

/** What a browser socket's path, ticket and Origin resolved to at the upgrade. */
interface BrowserSocketScope {
  /** The upgrade's `Origin`, checked again against the sandbox every heartbeat. */
  origin: string;
  projectId: string;
  sandboxConfigId: string;
  stageId: string;
  /** The user and sandbox the socket opened for; a refresh must name the same. */
  ticket: BrowserTicket;
  /** The ticket as sent, opened again every heartbeat. */
  token: string;
}

/** A browser's end user, its one action in flight, and its rate window. */
interface BrowserSlot {
  /** Settles once the action in flight is answered; the next one waits on it. */
  idle: Promise<void>;
  userId: string;
  windowCount: number;
  windowStartedAt: number;
}

/** A stage's deployment and its signing secret, opened. */
interface BrowserStage {
  deployment: SealedAgentDeployment;
  secret: string;
}

/** One heartbeat sweep's lookups, shared by every browser it revalidates. */
interface BrowserSweep {
  records: Map<string, Promise<SandboxConfigRecord | null>>;
  stages: Map<string, Promise<BrowserStage | null>>;
}

interface MachineConnection {
  /** Set on a browser socket, never on a daemon's. */
  browser?: BrowserSlot;
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
  /** Unset for a bearer with no account. */
  accountId?: string;
  /** The bearer it upgraded with, resolved again every heartbeat. */
  authorization?: string;
  /** Set for a browser socket, which a `bbt_` ticket opened. */
  browser?: BrowserSocketScope;
  claimed?: boolean;
  /** Set once the socket closes, so a claim still awaiting its lookup drops it. */
  closed?: boolean;
  /**
   * Unix ms a stage ticket dies at, and the timer that closes the socket then.
   * A credential frame with a fresh ticket moves both.
   */
  expiresAt?: number;
  expiry?: ReturnType<typeof setTimeout>;
  key?: string;
  /** A browser upgrade core refused: the open handler closes with it at once. */
  refusal?: { code: number; reason: string };
  /** Set for a role session, whose policy decides what it may claim. */
  role?: RolePrincipal;
  /** The sandbox a role session claimed, checked again on every heartbeat. */
  claim?: ApiResource;
  /** Set for a stage ticket or a stage-pinned role, which claim only their own stage's records. */
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

/** A socket upgrade core serves: a daemon's, or a browser's on its stage path. */
export function isMachineUpgrade(request: Request): boolean {
  const pathname = new URL(request.url).pathname;

  return (
    request.method === "GET" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    (pathname === MACHINE_WEBSOCKET_PATH ||
      matchBrowserSocketPath(pathname) !== null)
  );
}

export const machineWebSocketHandler: Bun.WebSocketHandler<MachineSocketData> =
  {
    maxPayloadLength: MACHINE_MAX_FRAME_BYTES,
    open: function (socket): void {
      const refusal = socket.data.refusal;
      if (refusal) {
        socket.close(refusal.code, refusal.reason);

        return;
      }
      armExpiry(socket);
    },
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
      // A browser's keepalive: Chrome stops an extension's service worker
      // after 30 idle seconds, and only traffic on the socket counts.
      if (frame.type === "ping") return;
      const browser = socket.data.browser;
      // A ticket or a role decides what a socket may claim, never its hello.
      if (
        frame.type === "hello" &&
        (frame.browser === true) !== Boolean(browser)
      ) {
        socket.close(
          MACHINE_CLOSE.badFrame.code,
          MACHINE_CLOSE.badFrame.reason,
        );

        return;
      }
      if (frame.type === "credential") {
        void (browser
          ? refreshBrowserTicket(socket, browser, frame.token)
          : refreshCredential(socket, frame.token));

        return;
      }
      if (frame.type !== "hello") {
        if (socket.data.key) settleReply(socket.data.key, frame);

        return;
      }
      socket.data.claimed = true;
      if (browser) {
        claimBrowser(socket, accountId, browser, frame);

        return;
      }
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

/**
 * One browser action on the browser `userId` holds open for this sandbox, and
 * no one else's. Core checks the call before it leaves: the action's own
 * fields, and an https URL inside the sandbox's `allowedDomains` for navigate
 * and upload_file. A user's actions run one at a time, at most
 * BROWSER_ACTIONS_PER_SECOND, and the answer comes back capped.
 * @throws when the input is refused, the browser is not connected, or it does not answer
 */
export async function runBrowserAction(
  config: SandboxExecutorConfig,
  userId: string,
  input: BrowserInput,
): Promise<MachineBrowserResultFrame> {
  const plane = config.controlPlane;
  const scope = browserMachineScope(config);
  if (!plane?.sandboxConfigId || !scope) {
    throw new Error('the browser tool needs a scope: "user" machine sandbox');
  }
  const action = checkedBrowserAction(input, scope);
  const key = browserKey(plane.accountId, plane.sandboxConfigId, userId);
  const offline = `the browser of the person this run belongs to is not connected to "${plane.name}". They need the extension open and signed in.`;
  const connection = connections.get(key);
  const slot = connection?.browser;
  if (!connection || !slot) throw new Error(offline);
  const now = Date.now();
  if (now - slot.windowStartedAt >= 1000) {
    slot.windowStartedAt = now;
    slot.windowCount = 0;
  }
  slot.windowCount += 1;
  if (slot.windowCount > BROWSER_ACTIONS_PER_SECOND) {
    throw new Error(
      `more than ${BROWSER_ACTIONS_PER_SECOND} browser actions a second; slow down`,
    );
  }
  const frame: MachineBrowserFrame = {
    type: "browser",
    id: crypto.randomUUID(),
    input: action,
  };
  // Queued behind the action in flight, so the page sees one at a time. A
  // socket replaced or closed meanwhile gets nothing more.
  const answer = slot.idle.then((): Promise<MachineReply> => {
    if (connections.get(key) !== connection) throw new Error(offline);

    return sendFrame(connection, frame, BROWSER_REPLY_MS);
  });
  slot.idle = answer.then(
    (): void => undefined,
    (): void => undefined,
  );
  const reply = await answer;
  if (reply.type !== "browser-result") {
    throw new Error(`browser answered a browser action with ${reply.type}`);
  }

  return cappedBrowserResult(reply);
}

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

/** The server's CallToolResult as JSON; the MCP client parses it. */
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

/** The server's tools as JSON; the MCP client parses them. */
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

/**
 * Upgrades even a bearer with no account, so the daemon reads a 4401 close
 * through the gateway relay instead of a bare 1006.
 */
export async function upgradeMachineSocket(
  request: Request,
  server: Bun.Server<MachineSocketData>,
): Promise<Response | undefined> {
  const browserPath = matchBrowserSocketPath(new URL(request.url).pathname);
  if (browserPath) {
    const data = await browserSocketData(request, browserPath);

    return server.upgrade(request, { data: data })
      ? undefined
      : Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
  }
  const auth = await resolveBearerAuth({
    authorization: request.headers.get("authorization") ?? "",
  });
  // A claim receives every exec frame, env secrets included, for the sandbox.
  // So the embeddable runtime key is refused (it sits in frontends), and so
  // is a stage ticket any org member can mint in the dashboard: only one
  // minted for a member who may write the stage's sandboxes gets through.
  // The bearer stays with the socket so each heartbeat resolves it again: a
  // revoked key, an ended role session or a suspended account loses the
  // claim within a minute, and a ticket closes the socket when it expires.
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
      // A stage-pinned role claims like a ticket for its stage.
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

// No `:` in a user id, so the key splits one way only.
function browserKey(
  accountId: string,
  sandboxConfigId: string,
  userId: string,
): string {
  return `${accountId}:${sandboxConfigId}:${userId}`;
}

// The stage's own scope-user record of that name, else an account-level one,
// as a daemon claims: never another stage's.
async function browserSandboxRecord(
  deployment: SealedAgentDeployment,
  name: string,
): Promise<SandboxConfigRecord | null> {
  const named = (
    await getStorage().sandboxConfigs.list(deployment.accountId)
  ).filter(
    (entry): boolean =>
      entry.name === name && browserMachineScope(entry.config) !== null,
  );

  return (
    named.find(
      (entry): boolean =>
        entry.projectId === deployment.projectId &&
        entry.stageId === deployment.stageId,
    ) ??
    named.find(
      (entry): boolean =>
        entry.projectId === undefined && entry.stageId === undefined,
    ) ??
    null
  );
}

// Everything is checked here, before the socket opens: the stage the path
// names, the ticket under its signing secret (once only), the sandbox it
// names, and the Origin against that sandbox's extensions. A refusal still
// upgrades, so the extension reads a close code through the gateway relay.
async function browserSocketData(
  request: Request,
  path: { projectId: string; stageId: string },
): Promise<MachineSocketData> {
  const token =
    extractBearerToken(request.headers.get("authorization") ?? undefined) ?? "";
  const origin = request.headers.get("origin");
  const refuse = (close: {
    code: number;
    reason: string;
  }): MachineSocketData => ({
    refusal: { code: close.code, reason: close.reason },
  });
  try {
    const stage = await browserStage(path.projectId, path.stageId);
    const ticket = stage && (await openBrowserTicket(token, stage.secret));
    if (!stage || !ticket || !spendTicket(path.stageId, ticket)) {
      return refuse(MACHINE_CLOSE.ticketRefused);
    }
    const record = await browserSandboxRecord(stage.deployment, ticket.sandbox);
    const scope = record && browserMachineScope(record.config);
    if (!record || !scope) return refuse(MACHINE_CLOSE.unknownBrowser);
    if (!origin || !originAllowed(origin, scope)) {
      logWarn("Browser socket refused for its origin", {
        accountId: stage.deployment.accountId,
        sandbox: ticket.sandbox,
        origin: origin ?? "none",
      });

      return refuse(MACHINE_CLOSE.originRefused);
    }

    return {
      accountId: stage.deployment.accountId,
      expiresAt: ticket.expiresAt,
      browser: {
        origin: origin,
        projectId: path.projectId,
        sandboxConfigId: record.sandboxId,
        stageId: path.stageId,
        ticket: ticket,
        token: token,
      },
    };
  } catch (error: unknown) {
    logWarn("Browser socket lookup failed", { error: toErrorMessage(error) });

    return refuse({ code: 1011, reason: "browser lookup failed" });
  }
}

// The stage's deployment with its signing secret opened, or null when it has
// no active deployment, an inactive account or no secret yet.
async function browserStage(
  projectId: string,
  stageId: string,
): Promise<BrowserStage | null> {
  const deployment = await getStorage().agentDeployments.getByStageIds(
    projectId,
    stageId,
  );
  if (!deployment?.userTokenSecret) return null;
  const { value } = await decryptAccountBlob(
    deployment.accountId,
    "agentDeployments:userTokenSecretCiphertext",
    deployment.userTokenSecret,
  );

  return typeof value === "string"
    ? { deployment: deployment, secret: value }
    : null;
}

// Why core will not send the browser to `url`: https only, so never chrome:,
// file:, javascript: or data:, and inside allowedDomains when the sandbox sets it.
function browserUrlRefusal(
  url: string,
  scope: BrowserMachineScope,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${JSON.stringify(url)} is not a URL`;
  }
  if (parsed.protocol !== "https:") {
    return `only https URLs reach the browser, not ${parsed.protocol}`;
  }
  if (parsed.username || parsed.password) {
    return "a URL for the browser must not carry credentials";
  }
  if (!browserHostAllowed(parsed.hostname, scope.allowedDomains)) {
    return `${parsed.hostname} is outside this sandbox's allowedDomains`;
  }

  return null;
}

// The extension's answer within what a model may be handed: page text cut at
// BROWSER_MAX_TEXT_BYTES, and a screenshot only of a known type and size.
function cappedBrowserResult(
  reply: MachineBrowserResultFrame,
): MachineBrowserResultFrame {
  const image =
    reply.image &&
    BROWSER_IMAGE_TYPES.has(reply.image.mediaType) &&
    reply.image.data.length <= BROWSER_MAX_IMAGE_CHARS
      ? reply.image
      : undefined;
  const error =
    reply.error ??
    (reply.image && !image
      ? "the browser's screenshot was dropped: it must be png, jpeg or webp and at most 3 MB of base64"
      : undefined);

  return {
    type: "browser-result",
    id: reply.id,
    ...(reply.text === undefined
      ? {}
      : { text: truncateText(reply.text, BROWSER_MAX_TEXT_BYTES).value }),
    ...(image ? { image: image } : {}),
    ...(error ? { error: error } : {}),
  };
}

// The call as the extension receives it: only the fields its action reads,
// each in range, and any URL one core may send. Throws the reason otherwise.
function checkedBrowserAction(
  input: BrowserInput,
  scope: BrowserMachineScope,
): BrowserAction {
  const parsed = browserAction.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue): string => `${issue.path.join(".") || "input"}: ${issue.message}`,
    );
    throw new Error(`invalid ${input.action} call (${issues.join("; ")})`);
  }
  const action = parsed.data;
  if (action.action === "navigate" || action.action === "upload_file") {
    const refusal = browserUrlRefusal(action.url, scope);
    if (refusal) throw new Error(refusal);
  }

  return action;
}

// A browser's hello claims the slot of the user its ticket names, on the
// sandbox the upgrade resolved. That user's newer socket replaces the older
// one; another user's socket is another slot and never meets this one.
function claimBrowser(
  socket: Bun.ServerWebSocket<MachineSocketData>,
  accountId: string,
  scope: BrowserSocketScope,
  hello: MachineHelloFrame,
): void {
  if (hello.sandbox !== scope.ticket.sandbox) {
    socket.close(MACHINE_CLOSE.forbidden.code, MACHINE_CLOSE.forbidden.reason);

    return;
  }
  const userId = scope.ticket.userId;
  const key = browserKey(accountId, scope.sandboxConfigId, userId);
  const previous = connections.get(key);
  if (previous) {
    rejectPending(previous, MACHINE_CLOSE.replaced.reason);
    previous.socket.close(
      MACHINE_CLOSE.replaced.code,
      MACHINE_CLOSE.replaced.reason,
    );
  }
  socket.data.key = key;
  const ref: MachineConnectionRef = {
    accountId: accountId,
    connectionId: crypto.randomUUID(),
    sandboxConfigId: scope.sandboxConfigId,
    subject: userId,
  };
  connections.set(key, {
    browser: {
      idle: Promise.resolve(),
      userId: userId,
      windowCount: 0,
      windowStartedAt: 0,
    },
    computer: false,
    ...(hello.hostname ? { hostname: hello.hostname } : {}),
    ...(hello.instance ? { instance: hello.instance } : {}),
    mcp: new Set(),
    name: hello.sandbox,
    pending: new Map(),
    ref: ref,
    socket: socket,
  });
  sendReady(socket, scope.sandboxConfigId);
  mirrorConnection(() =>
    getStorage().machineConnections.connected({
      ...ref,
      computer: false,
      hostname: hello.hostname,
      mcp: [],
      platform: hello.platform,
    }),
  );
  heartbeat ??= setInterval(sendHeartbeats, HEARTBEAT_MS);
  logInfo("Browser connected", {
    accountId: accountId,
    sandbox: hello.sandbox,
  });
}

async function claimSandbox(
  socket: Bun.ServerWebSocket<MachineSocketData>,
  accountId: string,
  hello: MachineHelloFrame,
): Promise<void> {
  const stage = socket.data.stage;
  // A `scope: "user"` machine runs no daemon: only its users' browsers connect.
  const named = (await getStorage().sandboxConfigs.list(accountId)).filter(
    (entry) =>
      entry.name === hello.sandbox &&
      entry.config.provider === "machine" &&
      browserMachineScope(entry.config) === null,
  );
  // A socket that closed during the lookup already ran its close handler, so
  // registering it now would leave a dead holder that refuses the next daemon.
  if (socket.data.closed) return;
  // A stage ticket reaches its own stage's record, else an account-level one
  // of that name, never another stage's: a ticket for development must not
  // take over the production machine that shares its name.
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
  // Claiming a machine is a write on that sandbox, so a role session needs
  // sandboxes:write for it. The name only arrives in the hello, hence here.
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
  // The same daemon process reconnecting after a network drop reclaims its
  // record. Any other daemon, on any computer, is refused unless it passes
  // --force, or the holder would lose the machine in silence. A daemon that
  // sends no instance counts as another daemon.
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

/** Whether a machine sandbox's daemon holds its socket right now. */
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

// An MCP row names its sandbox rather than the record id, so this scans the registry.
function machineServingMcp(record: McpRecord): MachineConnection {
  const sandbox = record.sandbox ?? "";
  const connection = [...connections.values()].find(
    (entry) =>
      entry.browser === undefined &&
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

// Status is for display only: a failed write never touches the daemon's socket.
function mirrorConnection(write: () => Promise<void>): void {
  Promise.resolve()
    .then(write)
    .catch((error: unknown): void => {
      logWarn("Machine connection mirror failed", {
        error: toErrorMessage(error),
      });
    });
}

// `chrome-extension://<id>` with `<id>` one the sandbox lists. A page, another
// extension, or a request with no Origin never reaches a person's browser.
function originAllowed(origin: string, scope: BrowserMachineScope): boolean {
  return (
    origin.startsWith(CHROME_EXTENSION_ORIGIN) &&
    scope.allowedExtensionIds.includes(
      origin.slice(CHROME_EXTENSION_ORIGIN.length),
    )
  );
}

// A fresh ticket moves a browser's deadline only when it opens under the
// stage's current secret, has not opened anything before, and names the same
// user and sandbox: another user or sandbox closes the socket with 4403. An
// outage keeps the old deadline and the extension tries again.
async function refreshBrowserTicket(
  socket: Bun.ServerWebSocket<MachineSocketData>,
  scope: BrowserSocketScope,
  token: string,
): Promise<void> {
  let ticket: BrowserTicket | null;
  try {
    const stage = await browserStage(scope.projectId, scope.stageId);
    ticket = stage && (await openBrowserTicket(token, stage.secret));
  } catch (error: unknown) {
    logWarn("Browser ticket refresh failed", {
      accountId: socket.data.accountId,
      error: toErrorMessage(error),
    });

    return;
  }
  const current = socket.data.browser;
  if (socket.data.closed || !current) return;
  if (!ticket || !spendTicket(current.stageId, ticket)) {
    socket.close(
      MACHINE_CLOSE.ticketRefused.code,
      MACHINE_CLOSE.ticketRefused.reason,
    );

    return;
  }
  if (
    ticket.userId !== current.ticket.userId ||
    ticket.sandbox !== current.ticket.sandbox
  ) {
    logWarn("Browser ticket refresh named another user or sandbox", {
      accountId: socket.data.accountId,
      sandbox: current.ticket.sandbox,
    });
    socket.close(MACHINE_CLOSE.forbidden.code, MACHINE_CLOSE.forbidden.reason);

    return;
  }
  // Two refreshes can resolve out of order; the older ticket never wins.
  if (ticket.expiresAt <= (socket.data.expiresAt ?? 0)) return;
  socket.data.browser = { ...current, ticket: ticket, token: token };
  socket.data.expiresAt = ticket.expiresAt;
  armExpiry(socket);
  const connection = socket.data.key
    ? connections.get(socket.data.key)
    : undefined;
  if (connection?.socket === socket) {
    sendReady(socket, current.sandboxConfigId);
  }
}

// Only a ticket socket's own account and stage, still allowed to write its
// sandboxes, moves the deadline: anything else closes, so a refresh never
// reaches what the socket could not claim. An outage keeps the old deadline
// and the daemon tries again.
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
    // Timers run late under load, so a frame never waits on the expiry one: a
    // daemon past its credential gets no exec, env or anything else.
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
  // One stage and sandbox lookup per sweep, however many browsers share them.
  const sweep: BrowserSweep = { records: new Map(), stages: new Map() };
  for (const connection of connections.values()) {
    mirrorConnection(() =>
      getStorage().machineConnections.seen(connection.ref),
    );
    const browser = connection.socket.data.browser;
    void (browser
      ? revalidateBrowser(connection.socket, browser, sweep)
      : revalidate(connection.socket));
  }
}

// An outage keeps the daemon: only a bearer that no longer resolves to the
// socket's account closes it, and an expired ticket closes as expired so the
// daemon reconnects with a fresh one instead of stopping.
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
  // A role keeps its claim only while its policy still lets it write there.
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
  const close =
    expiresAt !== undefined && expiresAt <= Date.now()
      ? MACHINE_CLOSE.expired
      : MACHINE_CLOSE.unauthorized;
  socket.close(close.code, close.reason);
}

// A browser keeps its socket only while its ticket still opens under the
// stage's current secret (a rotation closes every browser), and its sandbox
// is still a scope-user machine that lists its Origin. An outage keeps it.
async function revalidateBrowser(
  socket: Bun.ServerWebSocket<MachineSocketData>,
  scope: BrowserSocketScope,
  sweep: BrowserSweep,
): Promise<void> {
  const stageKey = `${scope.projectId}:${scope.stageId}`;
  let stage: BrowserStage | null;
  let record: SandboxConfigRecord | null = null;
  try {
    let stageLookup = sweep.stages.get(stageKey);
    if (!stageLookup) {
      stageLookup = browserStage(scope.projectId, scope.stageId);
      sweep.stages.set(stageKey, stageLookup);
    }
    stage = await stageLookup;
    if (stage) {
      const recordKey = `${stageKey}:${scope.ticket.sandbox}`;
      let recordLookup = sweep.records.get(recordKey);
      if (!recordLookup) {
        recordLookup = browserSandboxRecord(
          stage.deployment,
          scope.ticket.sandbox,
        );
        sweep.records.set(recordKey, recordLookup);
      }
      record = await recordLookup;
    }
  } catch (error: unknown) {
    logWarn("Browser revalidation failed", {
      accountId: socket.data.accountId,
      error: toErrorMessage(error),
    });

    return;
  }
  // A refresh that landed meanwhile is the ticket to judge now.
  const current = socket.data.browser;
  if (socket.data.closed || !current) return;
  const opened =
    stage && (await openBrowserTicket(current.token, stage.secret));
  if (socket.data.closed) return;
  if (!opened) {
    const close =
      (socket.data.expiresAt ?? 0) <= Date.now()
        ? MACHINE_CLOSE.expired
        : MACHINE_CLOSE.ticketRefused;
    socket.close(close.code, close.reason);

    return;
  }
  const browserScope =
    record?.sandboxId === current.sandboxConfigId
      ? browserMachineScope(record.config)
      : null;
  if (!browserScope) {
    socket.close(
      MACHINE_CLOSE.unknownBrowser.code,
      MACHINE_CLOSE.unknownBrowser.reason,
    );

    return;
  }
  if (!originAllowed(current.origin, browserScope)) {
    socket.close(
      MACHINE_CLOSE.originRefused.code,
      MACHINE_CLOSE.originRefused.reason,
    );
  }
}

// A ticket socket learns how long it has, so the daemon refreshes in time.
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

// Records a ticket's first use, and drops the expired ones; false when it
// opened a socket or a refresh before.
function spendTicket(stageId: string, ticket: BrowserTicket): boolean {
  const now = Date.now();
  for (const [spent, expiresAt] of spentTickets) {
    if (expiresAt <= now) spentTickets.delete(spent);
  }
  const key = `${stageId}:${ticket.jti}`;
  if (spentTickets.has(key)) return false;
  spentTickets.set(key, ticket.expiresAt);

  return true;
}
