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
  heartbeatIntervalMs,
  resumeGatewayUrl,
  SESSION_ENDING_CLOSE_CODES,
  type GatewayHello,
  type GatewayPayload,
  type GatewayReady,
  type MessageCreate,
} from "./discord.ts";
import type { IdentifyBudget } from "./identify-budget.ts";
import { logError, logInfo, logWarn, tokenHint } from "./log.ts";

// Sent when we close a socket ourselves and mean to RESUME. 1000 and 1001 tell
// Discord the session is finished, which makes the next connect a fresh IDENTIFY.
const RESUMABLE_CLOSE_CODE = 4000;

// Discord sends HELLO within about a second of the socket opening. Well past
// that and the connection is not going to start working on its own — see the
// watchdog in `dial`.
const CONNECT_DEADLINE_MS = 30_000;

export type SocketState =
  "backoff" | "connecting" | "exhausted" | "fatal" | "ready" | "stopped";

export interface GatewaySocketOptions {
  botToken: string;
  budget: IdentifyBudget;
  config: ForwarderConfig;
  onMessageCreate: (data: MessageCreate) => void;
}

export class GatewaySocket {
  /** The bot's own Discord user id, learned from READY. Null before then. */
  botIdentity: string | null = null;
  state: SocketState = "stopped";

  private readonly hint: string;
  private readonly options: GatewaySocketOptions;

  private attempt = 0;
  private awaitingAck = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeUrl: string | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private socket: WebSocket | null = null;

  constructor(options: GatewaySocketOptions) {
    this.hint = tokenHint(options.botToken);
    this.options = options;
  }

  start(): void {
    if (this.state !== "stopped") return;
    this.state = "connecting";
    this.dial();
  }

  stop(): void {
    this.state = "stopped";
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    // 1000, not 4000: this token is going away, so the session should end rather
    // than be held open for a RESUME that will never come.
    socket?.close(1000, "forwarder shutting down");
  }

  private clearTimers(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private dial(): void {
    if (this.state === "stopped") return;
    // `resumeUrl` only ever holds a value this same function already rebuilt, so
    // at runtime this second pass cannot change it. It is here for the sink: the
    // URL decides where the RESUME frame's bot token goes, and sanitizing at the
    // point of use keeps that provable locally, by eye and to the taint analyzer,
    // instead of resting on the field's every assignment staying clean. Do not
    // "simplify" it away — it costs one regex per dial.
    //
    // A session whose URL does not survive the rebuild is no session, which is
    // what makes one nullable value enough to decide both whether to reserve an
    // IDENTIFY and whether to send RESUME.
    const resumeUrl =
      this.sessionId && this.resumeUrl
        ? resumeGatewayUrl(this.resumeUrl)
        : null;
    if (!resumeUrl && !this.reserveIdentify()) return;

    this.state = "connecting";
    const socket = new WebSocket(
      `${resumeUrl ?? DISCORD_GATEWAY_URL}/?v=10&encoding=json`,
    );
    this.socket = socket;

    // A throw inside a socket listener escapes as an uncaught exception and
    // kills the process, which restarts and spends another IDENTIFY. One
    // malformed frame is not worth that, so it is logged and dropped.
    socket.addEventListener("message", (event: MessageEvent): void => {
      try {
        this.handlePayload(socket, Boolean(resumeUrl), String(event.data));
      } catch (error) {
        logError("Discord gateway frame could not be handled", {
          error: error instanceof Error ? error.message : String(error),
          tokenHint: this.hint,
        });
      }
    });
    socket.addEventListener("close", (event: CloseEvent): void => {
      this.handleClose(socket, event.code, event.reason);
    });
    // An error is always followed by a close, so let the close handler decide.
    socket.addEventListener("error", (): void => socket.close());

    // Every other timer in this class is armed by an event that has to arrive
    // first: the heartbeat by HELLO, the reconnect by a close. So a socket that
    // opens and then goes silent — no HELLO, or a READY this code cannot read —
    // holds no timer at all and stays half-open for the life of the process,
    // with that bot quietly answering nothing. This is the one timer that does
    // not wait to be invited.
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      logWarn("Discord gateway never became ready, reconnecting", {
        tokenHint: this.hint,
      });
      socket.close(RESUMABLE_CLOSE_CODE, "never became ready");
    }, CONNECT_DEADLINE_MS);
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
        tokenHint: this.hint,
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
    if (this.state === "stopped") return;

    const fatal = FATAL_CLOSE_CODES.get(code);
    if (fatal) {
      this.state = "fatal";
      logError("Discord gateway refused this bot, not reconnecting", {
        closeCode: code,
        detail: fatal,
        tokenHint: this.hint,
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
    resuming: boolean,
    raw: string,
  ): void {
    if (socket !== this.socket) return;
    const payload = JSON.parse(raw) as GatewayPayload;
    if (typeof payload.s === "number") this.sequence = payload.s;

    if (payload.op === GatewayOpcode.Hello) {
      const hello = payload.d as GatewayHello;
      this.awaitingAck = false;
      // Discord sends one HELLO per connection, but a second would orphan the
      // first interval past `clearTimers`, leaving it beating on a dead socket.
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(
        () => this.heartbeat(socket),
        heartbeatIntervalMs(hello.heartbeat_interval),
      );
      this.send(
        socket,
        resuming ? this.resumePayload() : this.identifyPayload(),
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
      this.botIdentity = ready.user.id;
      this.resumeUrl = resumeGatewayUrl(ready.resume_gateway_url);
      if (!this.resumeUrl) {
        // Dropping it costs one IDENTIFY on the next reconnect. Following it
        // would post the bot token to whoever named the host.
        logWarn("Discord named a resume host outside Discord, ignoring it", {
          tokenHint: this.hint,
        });
      }
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
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.attempt = 0;
    this.state = "ready";
    logInfo(message, {
      botUserId: this.botIdentity ?? undefined,
      botUsername: botUsername,
      tokenHint: this.hint,
    });
  }

  /**
   * Claims one IDENTIFY from the token's allowance, or parks the socket until the
   * window has room. Parking rather than retrying is the whole point: a thousand
   * IDENTIFYs in 24 hours resets the bot token and emails its owner.
   */
  private reserveIdentify(): boolean {
    const { botToken, budget } = this.options;
    if (budget.consume(botToken)) return true;

    const retryAt = budget.retryAt(botToken) ?? Date.now();
    const waitMs = Math.max(1_000, retryAt - Date.now());
    this.state = "exhausted";
    logError("Discord IDENTIFY budget exhausted, holding off", {
      tokenHint: this.hint,
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
    const { botToken, budget, config } = this.options;
    const delayMs = backoffDelayMs(this.attempt, config.backoffCeilingMs);
    this.attempt += 1;
    this.state = "backoff";
    logWarn("Discord gateway closed, reconnecting", {
      closeCode: code,
      identifiesLeft: budget.remaining(botToken),
      reason: reason || undefined,
      retryInSeconds: Math.round(delayMs / 1_000),
      tokenHint: this.hint,
    });
    this.reconnectTimer = setTimeout(() => this.dial(), delayMs);
  }

  private send(socket: WebSocket, payload: GatewayPayload): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}
