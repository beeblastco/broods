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

const CONNECT_DEADLINE_MS = 30_000;

// Discord asks for a random 1-5s wait after INVALID_SESSION before the next dial.
const INVALID_SESSION_MIN_WAIT_MS = 1_000;
const INVALID_SESSION_WAIT_SPREAD_MS = 4_000;

// Closing with 1000 or 1001 tells Discord the session is over, forcing a fresh IDENTIFY.
const RESUMABLE_CLOSE_CODE = 4000;

export type SocketState =
  | "backoff"
  | "connecting"
  | "exhausted"
  | "fatal"
  | "ready"
  | "stopped";

export interface GatewaySocketOptions {
  botToken: string;
  budget: IdentifyBudget;
  config: ForwarderConfig;
  onMessageCreate: (data: MessageCreate) => void;
}

export class GatewaySocket {
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
    socket?.close(1000, "forwarder shutting down");
  }

  /** Re-dials now rather than wait on a close event a partitioned socket may never deliver. */
  private abandon(socket: WebSocket, reason: string, minDelayMs = 0): void {
    socket.close(RESUMABLE_CLOSE_CODE, reason);
    this.handleClose(socket, RESUMABLE_CLOSE_CODE, reason, minDelayMs);
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
    // Re-proved at the point of use, since RESUME carries the token; failing it means no session.
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

    // Uncaught, a throw here restarts the process and spends an IDENTIFY on one bad frame.
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
    // An error is always followed by a close, so the close handler decides.
    socket.addEventListener("error", (): void => socket.close());

    // Every other timer waits on an event, so without this a silent socket stays half-open.
    this.connectTimer = setTimeout((): void => {
      if (this.socket !== socket) return;
      logWarn("Discord gateway never became ready, reconnecting", {
        tokenHint: this.hint,
      });
      this.abandon(socket, "never became ready");
    }, CONNECT_DEADLINE_MS);
  }

  private forgetSession(): void {
    this.resumeUrl = null;
    this.sequence = null;
    this.sessionId = null;
  }

  private handleClose(
    socket: WebSocket,
    code: number,
    reason: string,
    minDelayMs = 0,
  ): void {
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

    this.scheduleReconnect(code, reason, minDelayMs);
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
      const intervalMs = heartbeatIntervalMs(hello.heartbeat_interval);
      // A second HELLO would otherwise orphan the first timer past `clearTimers`.
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      // Discord wants the first beat jittered across one interval.
      this.heartbeatTimer = setTimeout((): void => {
        // Armed before the beat, so a beat that abandons the socket clears it.
        this.heartbeatTimer = setInterval(
          (): void => this.heartbeat(socket),
          intervalMs,
        );
        this.heartbeat(socket);
      }, intervalMs * Math.random());
      this.send(
        socket,
        resuming ? this.resumePayload() : this.identifyPayload(),
      );

      return;
    }

    if (payload.op === GatewayOpcode.Heartbeat) {
      this.awaitingAck = true;
      this.send(socket, { op: GatewayOpcode.Heartbeat, d: this.sequence });

      return;
    }

    if (payload.op === GatewayOpcode.HeartbeatAck) {
      this.awaitingAck = false;

      return;
    }

    if (payload.op === GatewayOpcode.Reconnect) {
      this.abandon(socket, "gateway asked for a reconnect");

      return;
    }
    if (payload.op === GatewayOpcode.InvalidSession) {
      if (payload.d !== true) this.forgetSession();
      this.abandon(
        socket,
        "gateway invalidated the session",
        INVALID_SESSION_MIN_WAIT_MS +
          Math.random() * INVALID_SESSION_WAIT_SPREAD_MS,
      );

      return;
    }

    if (payload.t === "READY") {
      const ready = payload.d as GatewayReady;
      this.botIdentity = ready.user.id;
      this.resumeUrl = resumeGatewayUrl(ready.resume_gateway_url);
      if (!this.resumeUrl) {
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

  private heartbeat(socket: WebSocket): void {
    if (this.awaitingAck) {
      logWarn("Discord gateway heartbeat unacknowledged, reconnecting", {
        tokenHint: this.hint,
      });
      this.abandon(socket, "heartbeat not acknowledged");

      return;
    }
    this.awaitingAck = true;
    this.send(socket, { op: GatewayOpcode.Heartbeat, d: this.sequence });
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
    this.reconnectTimer = setTimeout((): void => this.dial(), waitMs);

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

  private scheduleReconnect(
    code: number,
    reason: string,
    minDelayMs: number,
  ): void {
    const { botToken, budget, config } = this.options;
    const delayMs = Math.max(
      minDelayMs,
      backoffDelayMs(this.attempt, config.backoffCeilingMs),
    );
    this.attempt += 1;
    this.state = "backoff";
    logWarn("Discord gateway closed, reconnecting", {
      closeCode: code,
      identifiesLeft: budget.remaining(botToken),
      reason: reason || undefined,
      retryInSeconds: Math.round(delayMs / 1_000),
      tokenHint: this.hint,
    });
    this.reconnectTimer = setTimeout((): void => this.dial(), delayMs);
  }

  private send(socket: WebSocket, payload: GatewayPayload): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}
