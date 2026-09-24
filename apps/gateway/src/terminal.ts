import { createHash } from "node:crypto";
import { NatsError as NatsTcpError } from "nats";
import {
  Empty,
  NatsError,
  StorageType,
  type KV,
  type NatsConnection,
} from "nats.ws";
import {
  openTerminalTicket,
  TERMINAL_TICKET_TTL_MS,
  type TerminalTicket,
} from "../../core/src/shared/terminal-ticket.ts";
import { MACHINE_MAX_FRAME_BYTES } from "../../core/src/shared/machine-socket.ts";
import { VIA_GATEWAY_HEADER } from "../../../packages/convex/model/serviceBridge.ts";

export const MAX_PENDING_TERMINAL_BYTES = 64 * 1024;
// Two of the largest machine frames, so one still in flight never trips it.
const MAX_UPSTREAM_BUFFERED_BYTES = 2 * MACHINE_MAX_FRAME_BYTES;
// JetStream's error code for a KV create on a key that already holds a value.
const KV_KEY_EXISTS = 10071;
const SPENT_TICKET_BUCKET = "TERMINAL_TICKETS_SPENT";

export type TerminalGatewayData = {
  kind: "terminal";
  /** Null when the ticket did not verify: the socket is closed on open with `TERMINAL_TICKET_REJECTED`. */
  ticket: TerminalTicket | null;
};

/** A `broods machine` daemon, relayed to core, which checks its bearer. */
export type MachineGatewayData = {
  kind: "machine";
  ticket: Pick<TerminalTicket, "url" | "authorization" | "authorizationHeader">;
};

export type RelayGatewayData = MachineGatewayData | TerminalGatewayData;

/**
 * Where the gateway records used terminal tickets. It spends a ticket before
 * the upgrade and releases it when the upgrade fails.
 */
export interface SpentTickets {
  /** True when this call spent the ticket, false when it was already spent. */
  spend(token: string): Promise<boolean>;
  /** Makes a ticket whose socket never opened usable again. */
  release(token: string): Promise<void>;
}

/**
 * Application close code for a ticket the gateway could not open. A refused
 * HTTP upgrade reaches the browser as a bare 1006 with no reason, so the
 * rejection is delivered on the socket instead, where the client can read it.
 */
export const TERMINAL_TICKET_REJECTED = {
  code: 4401,
  reason: "Invalid, expired or already used terminal ticket",
} as const;

type TerminalSocketState = {
  upstream: WebSocket | null;
  pending: (string | Uint8Array<ArrayBuffer>)[];
  pendingBytes: number;
};

const terminalState = new WeakMap<
  Bun.ServerWebSocket<RelayGatewayData>,
  TerminalSocketState
>();

export function openTerminalTicketWithSecrets(
  token: string,
  secrets: string[],
): TerminalTicket | null {
  if (!token.trim()) return null;

  for (const secret of secrets) {
    const ticket = openTerminalTicket(token, secret);
    if (ticket) return ticket;
  }

  return null;
}

/**
 * Spent terminal tickets in a JetStream KV bucket, shared by every gateway
 * replica and kept across restarts, so a ticket copied out of a log cannot open
 * a second shell. Keys live as long as a ticket can, then NATS drops them.
 */
export function natsSpentTickets(
  connection: () => Promise<NatsConnection>,
): SpentTickets {
  async function bucket(): Promise<KV> {
    return (await connection()).jetstream().views.kv(SPENT_TICKET_BUCKET, {
      history: 1,
      storage: StorageType.File,
      ttl: TERMINAL_TICKET_TTL_MS,
    });
  }

  return {
    spend: async function (token: string): Promise<boolean> {
      try {
        await (await bucket()).create(spentTicketKey(token), Empty);

        return true;
      } catch (error: unknown) {
        // `connectNats` dials `nats://` with the TCP client, whose errors are
        // their own class.
        if (
          (error instanceof NatsError || error instanceof NatsTcpError) &&
          error.api_error?.err_code === KV_KEY_EXISTS
        ) {
          return false;
        }
        throw error;
      }
    },
    release: async function (token: string): Promise<void> {
      await (await bucket()).delete(spentTicketKey(token));
    },
  };
}

export function isSessionInitFrame(frame: string): boolean {
  if (!frame.startsWith("{")) return false;

  // Parsed here, not with utils.ts `parseJson`: core's machine relay test
  // compiles this file under core's tsconfig, which utils.ts does not pass.
  try {
    const parsed: unknown = JSON.parse(frame);

    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "session_init"
    );
  } catch {
    return false;
  }
}

export function openTerminalUpstream(
  socket: Bun.ServerWebSocket<RelayGatewayData>,
): void {
  const ticket = socket.data.ticket;
  if (!ticket) {
    socket.close(
      TERMINAL_TICKET_REJECTED.code,
      TERMINAL_TICKET_REJECTED.reason,
    );

    return;
  }
  const state: TerminalSocketState = {
    upstream: null,
    pending: [],
    pendingBytes: 0,
  };
  terminalState.set(socket, state);

  let upstream: WebSocket;
  try {
    upstream = new WebSocket(ticket.url, {
      headers: {
        [ticket.authorizationHeader ?? "authorization"]: ticket.authorization,
        ...(socket.data.kind === "machine"
          ? { [VIA_GATEWAY_HEADER]: "1" }
          : {}),
      },
    } as unknown as string[]);
  } catch {
    socket.close(1011, "failed to reach the sandbox terminal");

    return;
  }

  upstream.binaryType = "arraybuffer";
  state.upstream = upstream;

  upstream.onopen = (): void => {
    for (const chunk of state.pending) upstream.send(chunk);
    state.pending = [];
    state.pendingBytes = 0;
  };

  let firstFrame = true;
  upstream.onmessage = (event): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (firstFrame) {
      firstFrame = false;
      if (typeof event.data === "string" && isSessionInitFrame(event.data))
        return;
    }

    try {
      if (typeof event.data === "string") {
        socket.send(event.data);
      } else {
        socket.send(new Uint8Array(event.data as ArrayBuffer));
      }
    } catch {
      return;
    }
  };

  upstream.onclose = (event): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    // A daemon reads core's close code to decide whether to reconnect.
    if (socket.data.kind === "machine") {
      socket.close(relayCloseCode(event.code), event.reason);
    } else {
      socket.close(1000, "terminal session ended");
    }
  };

  upstream.onerror = (): void => {
    // An error arrives with the close that follows it, and a daemon decides
    // whether to reconnect from that close code, so leave machine sockets to
    // `onclose` rather than closing them with one it does not read.
    if (socket.readyState !== WebSocket.OPEN || socket.data.kind === "machine")
      return;
    socket.close(1011, "sandbox terminal transport error");
  };
}

export function relayTerminalInput(
  socket: Bun.ServerWebSocket<RelayGatewayData>,
  rawMessage: string | Buffer,
): void {
  const state = terminalState.get(socket);
  if (!state) return;

  const chunk =
    typeof rawMessage === "string"
      ? rawMessage
      : (new Uint8Array(rawMessage) as Uint8Array<ArrayBuffer>);
  if (state.upstream && state.upstream.readyState === WebSocket.OPEN) {
    // An upstream that stopped draining would otherwise buffer without end.
    if (state.upstream.bufferedAmount > MAX_UPSTREAM_BUFFERED_BYTES) {
      socket.close(1009, "terminal upstream is not draining");

      return;
    }
    state.upstream.send(chunk);

    return;
  }

  state.pendingBytes +=
    typeof chunk === "string" ? chunk.length : chunk.byteLength;
  if (state.pendingBytes > MAX_PENDING_TERMINAL_BYTES) {
    socket.close(1009, "terminal input buffer exceeded");

    return;
  }

  state.pending.push(chunk);
}

export function cleanupTerminalSocket(
  socket: Bun.ServerWebSocket<RelayGatewayData>,
): void {
  const state = terminalState.get(socket);
  if (!state) return;

  terminalState.delete(socket);
  if (state.upstream && state.upstream.readyState !== WebSocket.CLOSED) {
    try {
      state.upstream.close(1000, "client disconnected");
    } catch {
      return;
    }
  }
}

// A close frame can only carry 1000 or 4000-4999; the daemon retries on 1011.
function relayCloseCode(code: number): number {
  return code === 1000 || (code >= 4000 && code <= 4999) ? code : 1011;
}

// A sealed ticket holds characters a KV key cannot, and the bucket should not
// hold the ticket itself, so the key is its SHA-256.
function spentTicketKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
