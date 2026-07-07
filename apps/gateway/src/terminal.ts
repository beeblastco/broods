import {
  openTerminalTicket,
  type TerminalTicket,
} from "../../core/src/shared/terminal-ticket.ts";

export const MAX_PENDING_TERMINAL_BYTES = 64 * 1024;

export type TerminalGatewayData = {
  kind: "terminal";
  ticket: TerminalTicket;
};

type TerminalSocketState = {
  upstream: WebSocket | null;
  pending: (string | Uint8Array<ArrayBuffer>)[];
  pendingBytes: number;
};

const terminalState = new WeakMap<
  Bun.ServerWebSocket<TerminalGatewayData>,
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
  socket: Bun.ServerWebSocket<TerminalGatewayData>,
): void {
  const state: TerminalSocketState = {
    upstream: null,
    pending: [],
    pendingBytes: 0,
  };
  terminalState.set(socket, state);

  let upstream: WebSocket;
  try {
    upstream = new WebSocket(socket.data.ticket.url, {
      headers: {
        [socket.data.ticket.authorizationHeader ?? "authorization"]:
          socket.data.ticket.authorization,
      },
    } as unknown as string[]);
  } catch {
    socket.close(1011, "failed to reach the sandbox terminal");
    return;
  }

  upstream.binaryType = "arraybuffer";
  state.upstream = upstream;

  upstream.onopen = () => {
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

  upstream.onclose = () => {
    if (socket.readyState === WebSocket.OPEN)
      socket.close(1000, "terminal session ended");
  };

  upstream.onerror = () => {
    if (socket.readyState === WebSocket.OPEN)
      socket.close(1011, "sandbox terminal transport error");
  };
}

export function relayTerminalInput(
  socket: Bun.ServerWebSocket<TerminalGatewayData>,
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
  socket: Bun.ServerWebSocket<TerminalGatewayData>,
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
