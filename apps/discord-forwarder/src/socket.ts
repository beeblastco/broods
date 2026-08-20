/**
 * One Discord Gateway socket, keyed by bot token.
 *
 * One socket per token is the only configuration that delivers each event once:
 * Discord permits several connections with identical shard tuples and sends
 * every event to all of them. So this class owns the token for the life of the
 * process, and `main.ts` guarantees exactly one instance per token.
 *
 * It reconnects itself, RESUMEs from the last sequence number when Discord still
 * accepts the session, and refuses to dial at all on a close code that cannot
 * start succeeding without a config change — retrying those is what spends the
 * per-token IDENTIFY allowance towards a token reset.
 */

import { backoffDelayMs } from "./backoff.ts";
import { GATEWAY_INTENTS, type ForwarderConfig } from "./config.ts";
import {
  DISCORD_GATEWAY_URL,
  FATAL_CLOSE_CODES,
  GatewayOpcode,
  SESSION_ENDING_CLOSE_CODES,
  type GatewayHello,
  type GatewayPayload,
  type GatewayReady,
  type MessageCreate,
} from "./discord.ts";
import type { IdentifyBudget } from "./identify-budget.ts";
import { logError, logInfo, logWarn } from "./log.ts";

// Sent when we close a socket ourselves and mean to RESUME. 1000 and 1001 tell
// Discord the session is finished, which makes the next connect a fresh IDENTIFY.
const RESUMABLE_CLOSE_CODE = 4000;

export type SocketState =
  "backoff" | "connecting" | "exhausted" | "fatal" | "ready" | "stopped";

export interface GatewaySocketOptions {
  botToken: string;
  budget: IdentifyBudget;
  config: ForwarderConfig;
  onMessageCreate: (data: MessageCreate) => void;
  tokenHint: string;
}

export class GatewaySocket {
  private readonly options: GatewaySocketOptions;

  private attempt = 0;
  private awaitingAck = false;
  private botUserId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeUrl: string | null = null;
  private running = false;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private socket: WebSocket | null = null;
  private socketState: SocketState = "stopped";

  constructor(options: GatewaySocketOptions) {
    this.options = options;
  }

  /** The bot's own Discord user id, learned from READY. Null before then. */
  get botIdentity(): string | null {
    return this.botUserId;
  }

  get state(): SocketState {
    return this.socketState;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.dial();
  }

  stop(): void {
    this.running = false;
    this.socketState = "stopped";
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    // 1000, not 4000: this token is going away, so the session should end rather
    // than be held open for a RESUME that will never come.
    socket?.close(1000, "forwarder shutting down");
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private dial(): void {
    if (!this.running) return;
    const canResume = Boolean(this.resumeUrl && this.sessionId);
    if (!canResume && !this.reserveIdentify()) return;

    this.socketState = "connecting";
    const base = canResume ? this.resumeUrl : DISCORD_GATEWAY_URL;
    const socket = new WebSocket(`${base}/?v=10&encoding=json`);
    this.socket = socket;

    // A throw inside a socket listener escapes as an uncaught exception and
    // kills the process, which restarts and spends another IDENTIFY. One
    // malformed frame is not worth that, so it is logged and dropped.
    socket.addEventListener("message", (event: MessageEvent): void => {
      try {
        this.handlePayload(socket, canResume, String(event.data));
      } catch (error) {
        logError("Discord gateway frame could not be handled", {
          error: error instanceof Error ? error.message : String(error),
          tokenHint: this.options.tokenHint,
        });
      }
    });
    socket.addEventListener("close", (event: CloseEvent): void => {
      this.handleClose(socket, event.code, event.reason);
    });
    // An error is always followed by a close, so let the close handler decide.
    socket.addEventListener("error", (): void => socket.close());
  }

  private forgetSession(): void {
    this.resumeUrl = null;
    this.sequence = null;
    this.sessionId = null;
  }

  /**
   * An interval tick that finds the previous beat still unacknowledged means the
   * socket is a zombie: open, but nothing is coming back. Close it and let the
   * close handler re-dial with a RESUME.
   */
  private heartbeat(socket: WebSocket): void {
    if (this.awaitingAck) {
      logWarn("Discord gateway heartbeat unacknowledged, reconnecting", {
        tokenHint: this.options.tokenHint,
      });
      socket.close(RESUMABLE_CLOSE_CODE, "heartbeat not acknowledged");

      return;
    }
    this.awaitingAck = true;
    this.send(socket, { op: GatewayOpcode.Heartbeat, d: this.sequence });
  }

  private handleClose(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.socket) return;
    this.clearTimers();
    this.socket = null;
    this.awaitingAck = false;
    if (!this.running) return;

    const fatal = FATAL_CLOSE_CODES.get(code);
    if (fatal) {
      this.socketState = "fatal";
      logError("Discord gateway refused this bot, not reconnecting", {
        closeCode: code,
        detail: fatal,
        tokenHint: this.options.tokenHint,
      });

      return;
    }
    if (SESSION_ENDING_CLOSE_CODES.has(code)) {
      this.forgetSession();
    }

    this.scheduleReconnect(code, reason);
  }

  private handlePayload(
    socket: WebSocket,
    canResume: boolean,
    raw: string,
  ): void {
    if (socket !== this.socket) return;
    const payload = JSON.parse(raw) as GatewayPayload;
    if (typeof payload.s === "number") this.sequence = payload.s;

    if (payload.op === GatewayOpcode.Hello) {
      const hello = payload.d as GatewayHello;
      this.awaitingAck = false;
      this.heartbeatTimer = setInterval(
        () => this.heartbeat(socket),
        hello.heartbeat_interval,
      );
      this.send(
        socket,
        canResume ? this.resumePayload() : this.identifyPayload(),
      );

      return;
    }

    // Op 1 from the server asks for a beat now; the ack still has to arrive, so
    // the zombie check stays armed.
    if (payload.op === GatewayOpcode.Heartbeat) {
      this.awaitingAck = true;
      this.send(socket, { op: GatewayOpcode.Heartbeat, d: this.sequence });

      return;
    }

    if (payload.op === GatewayOpcode.HeartbeatAck) {
      this.awaitingAck = false;

      return;
    }

    // 7 asks for a reconnect and keeps the session; 9 says the session is gone.
    // Both are handled by closing and letting the close handler dial again.
    if (payload.op === GatewayOpcode.Reconnect) {
      socket.close(RESUMABLE_CLOSE_CODE, "gateway asked for a reconnect");

      return;
    }
    if (payload.op === GatewayOpcode.InvalidSession) {
      this.forgetSession();
      socket.close(RESUMABLE_CLOSE_CODE, "gateway invalidated the session");

      return;
    }

    if (payload.t === "READY") {
      const ready = payload.d as GatewayReady;
      this.botUserId = ready.user.id;
      this.resumeUrl = ready.resume_gateway_url;
      this.sessionId = ready.session_id;
      this.markReady("Discord gateway ready", ready.user.username);

      return;
    }
    if (payload.t === "RESUMED") {
      this.markReady("Discord gateway resumed");

      return;
    }
    if (payload.t === "MESSAGE_CREATE") {
      this.options.onMessageCreate(payload.d as MessageCreate);
    }
  }

  private identifyPayload(): GatewayPayload {
    return {
      op: GatewayOpcode.Identify,
      d: {
        token: this.options.botToken,
        intents: GATEWAY_INTENTS,
        properties: {
          os: "linux",
          browser: "broods-discord-forwarder",
          device: "broods-discord-forwarder",
        },
      },
    };
  }

  private markReady(message: string, botUsername?: string): void {
    this.attempt = 0;
    this.socketState = "ready";
    logInfo(message, {
      botUserId: this.botUserId ?? undefined,
      botUsername: botUsername,
      tokenHint: this.options.tokenHint,
    });
  }

  /**
   * Claims one IDENTIFY from the token's allowance, or parks the socket until the
   * window has room. Parking rather than retrying is the whole point: a thousand
   * IDENTIFYs in 24 hours resets the bot token and emails its owner.
   */
  private reserveIdentify(): boolean {
    const { botToken, budget, tokenHint } = this.options;
    if (budget.consume(botToken)) return true;

    const retryAt = budget.retryAt(botToken) ?? Date.now();
    const waitMs = Math.max(1_000, retryAt - Date.now());
    this.socketState = "exhausted";
    logError("Discord IDENTIFY budget exhausted, holding off", {
      tokenHint: tokenHint,
      waitSeconds: Math.round(waitMs / 1_000),
    });
    this.reconnectTimer = setTimeout(() => this.dial(), waitMs);

    return false;
  }

  private resumePayload(): GatewayPayload {
    return {
      op: GatewayOpcode.Resume,
      d: {
        token: this.options.botToken,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    };
  }

  private scheduleReconnect(code: number, reason: string): void {
    const { botToken, budget, config, tokenHint } = this.options;
    const delayMs = backoffDelayMs(
      this.attempt,
      config.backoffBaseMs,
      config.backoffCeilingMs,
    );
    this.attempt += 1;
    this.socketState = "backoff";
    logWarn("Discord gateway closed, reconnecting", {
      closeCode: code,
      identifiesLeft: budget.remaining(botToken),
      reason: reason || undefined,
      retryInSeconds: Math.round(delayMs / 1_000),
      tokenHint: tokenHint,
    });
    this.reconnectTimer = setTimeout(() => this.dial(), delayMs);
  }

  private send(socket: WebSocket, payload: GatewayPayload): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}
