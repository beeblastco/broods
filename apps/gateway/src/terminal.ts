import {
  openTerminalTicket,
  type TerminalTicket,
} from "../../core/src/shared/terminal-ticket.ts";

export const MAX_PENDING_TERMINAL_BYTES = 64 * 1024;

export type TerminalGatewayData = {
  kind: "terminal";
  /** Null when the ticket did not verify: the socket is closed on open with `TERMINAL_TICKET_REJECTED`. */
  ticket: TerminalTicket | null;
};

/**
 * The daemon side of a machine sandbox (`broods machine`). Same relay as a
 * terminal, but the upstream is core, which authenticates the bearer itself,
 * so the "ticket" is just the daemon's own credential aimed at core.
 */
export type MachineGatewayData = {
  kind: "machine";
  ticket: TerminalTicket;
};

export type RelayGatewayData = MachineGatewayData | TerminalGatewayData;

/**
 * Application close code for a ticket the gateway could not open. A refused
 * HTTP upgrade reaches the browser as a bare 1006 with no reason, so the
 * rejection is delivered on the socket instead, where the client can read it.
 */
export const TERMINAL_TICKET_REJECTED = {
  code: 4401,
  reason: "Invalid or expired terminal ticket",
} as const;

type TerminalSocketState = {
  upstream: WebSocket | null;
  pending: (string | Uint8Array<ArrayBuffer>)[];
  pendingBytes: number;
};

/** Core refused the daemon's upgrade: bad key, or no core reachable. */
export const MACHINE_UPSTREAM_REJECTED = {
  code: 4401,
  reason: "Core refused the machine socket; check BROODS_API_KEY",
} as const;

const terminalState = new WeakMap<
  Bun.ServerWebSocket<RelayGatewayData>,
  TerminalSocketState
>();

export function terminalServiceSecretsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw =
    env.BROODS_SERVICE_AUTH_SECRETS ?? env.BROODS_SERVICE_AUTH_SECRET ?? "";

  return [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

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

export function isSessionInitFrame(frame: string): boolean {
  if (!frame.startsWith("{")) return false;

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
      },
    } as unknown as string[]);
  } catch {
    socket.close(1011, "failed to reach the sandbox terminal");

    return;
  }

  upstream.binaryType = "arraybuffer";
  state.upstream = upstream;

  let opened = false;
  upstream.onopen = () => {
    opened = true;
    for (const chunk of state.pending) upstream.send(chunk);
    state.pending = [];
    state.pendingBytes = 0;
  };

  let firstFrame = true;
  upstream.onmessage = (event) => {
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

  upstream.onclose = (event) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.data.kind === "machine") {
      // Core's own close code (4404 unknown sandbox, 4409 replaced) is the
      // daemon's only explanation, so it passes through untouched. A refused
      // upgrade never opens and arrives as a bare 1006.
      if (opened) socket.close(event.code, event.reason);
      else
        socket.close(
          MACHINE_UPSTREAM_REJECTED.code,
          MACHINE_UPSTREAM_REJECTED.reason,
        );

      return;
    }
    socket.close(1000, "terminal session ended");
  };

  upstream.onerror = () => {
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
