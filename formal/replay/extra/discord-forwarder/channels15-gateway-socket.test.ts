import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ForwarderConfig } from "../../../../apps/discord-forwarder/src/config.ts";
import {
  GatewayOpcode,
  type GatewayPayload,
  type MessageCreate,
} from "../../../../apps/discord-forwarder/src/discord.ts";
import { IdentifyBudget } from "../../../../apps/discord-forwarder/src/identify-budget.ts";
import { GatewaySocket } from "../../../../apps/discord-forwarder/src/socket.ts";

const CONFIG: ForwarderConfig = {
  backoffCeilingMs: 300_000,
  identifyLimit: 10,
  planes: [],
  port: 3000,
};
const HEARTBEAT_INTERVAL_MS = 40_000;
const RESUME_URL = "wss://gateway-us-east1-b.discord.gg";

const realWebSocket = globalThis.WebSocket;

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static opened: FakeWebSocket[] = [];

  readonly sent: GatewayPayload[] = [];
  readonly url: string;
  closeCode: number | null = null;
  readyState = FakeWebSocket.OPEN;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.opened.push(this);
  }

  close(code?: number): void {
    this.closeCode = code ?? 1000;
  }

  receive(payload: GatewayPayload): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as GatewayPayload);
  }
}

beforeEach((): void => {
  FakeWebSocket.opened = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  jest.useFakeTimers();
  jest.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach((): void => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  globalThis.WebSocket = realWebSocket;
});

function gatewaySocket(
  onMessage: (data: MessageCreate) => void = (): void => {},
  limit: number = CONFIG.identifyLimit,
): GatewaySocket {
  return new GatewaySocket({
    botToken: "token-a",
    budget: new IdentifyBudget(limit),
    config: CONFIG,
    onMessageCreate: onMessage,
  });
}

function hello(socket: FakeWebSocket): void {
  socket.receive({
    op: GatewayOpcode.Hello,
    d: { heartbeat_interval: HEARTBEAT_INTERVAL_MS },
  });
}

function ready(socket: FakeWebSocket, resumeUrl: string = RESUME_URL): void {
  socket.receive({
    op: GatewayOpcode.Dispatch,
    s: 1,
    t: "READY",
    d: {
      resume_gateway_url: resumeUrl,
      session_id: "session-1",
      user: { id: "bot-1", username: "bot" },
    },
  });
}

function started(): { gateway: GatewaySocket; first: FakeWebSocket } {
  const gateway = gatewaySocket();
  gateway.start();

  return { gateway: gateway, first: FakeWebSocket.opened[0]! };
}

describe("handlePayload", (): void => {
  test("forwards a MESSAGE_CREATE dispatch", (): void => {
    const seen: MessageCreate[] = [];
    const gateway = gatewaySocket((data): number => seen.push(data));
    gateway.start();
    const first = FakeWebSocket.opened[0]!;
    hello(first);
    ready(first);

    first.receive({
      op: GatewayOpcode.Dispatch,
      s: 2,
      t: "MESSAGE_CREATE",
      d: { id: "m1", channel_id: "c1" },
    });

    expect(seen).toEqual([{ id: "m1", channel_id: "c1" }]);
    gateway.stop();
  });

  test("marks the socket ready again on RESUMED", (): void => {
    const { gateway, first } = started();
    hello(first);
    first.receive({ op: GatewayOpcode.Dispatch, s: 1, t: "RESUMED", d: {} });

    expect(gateway.state).toBe("ready");
    gateway.stop();
  });

  test("ignores a resume host outside Discord and identifies on the next dial", (): void => {
    const { gateway, first } = started();
    hello(first);
    ready(first, "wss://evil.example");

    first.receive({ op: GatewayOpcode.Reconnect, d: null });
    jest.advanceTimersByTime(1_000);

    expect(gateway.botIdentity).toBe("bot-1");
    expect(FakeWebSocket.opened[1]!.url).toStartWith(
      "wss://gateway.discord.gg",
    );
    gateway.stop();
  });

  test("answers a server heartbeat request with the last sequence", (): void => {
    const { gateway, first } = started();
    hello(first);
    ready(first);

    first.receive({ op: GatewayOpcode.Heartbeat, d: null });

    expect(first.sent.at(-1)).toEqual({ op: GatewayOpcode.Heartbeat, d: 1 });
    gateway.stop();
  });

  test("lets a heartbeat ack clear the unanswered beat", (): void => {
    const { gateway, first } = started();
    hello(first);
    ready(first);
    first.receive({ op: GatewayOpcode.Heartbeat, d: null });
    first.receive({ op: GatewayOpcode.HeartbeatAck, d: null });

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(FakeWebSocket.opened).toHaveLength(1);
    gateway.stop();
  });

  test("re-dials when Discord asks for a reconnect", (): void => {
    const { gateway, first } = started();
    hello(first);

    first.receive({ op: GatewayOpcode.Reconnect, d: null });

    expect(first.closeCode).toBe(4000);
    expect(gateway.state).toBe("backoff");
    jest.advanceTimersByTime(1_000);
    expect(FakeWebSocket.opened).toHaveLength(2);
    gateway.stop();
  });

  test("replaces the heartbeat timer when a second HELLO arrives", (): void => {
    const { gateway, first } = started();
    hello(first);
    hello(first);

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    const beats = first.sent.filter(
      (payload): boolean => payload.op === GatewayOpcode.Heartbeat,
    );
    expect(beats).toHaveLength(1);
    gateway.stop();
  });
});

describe("handleClose", (): void => {
  test("stops reconnecting after a close code that refuses the bot", (): void => {
    const { gateway, first } = started();

    first.dispatchEvent(new CloseEvent("close", { code: 4004 }));
    jest.advanceTimersByTime(60_000);

    expect(gateway.state).toBe("fatal");
    expect(FakeWebSocket.opened).toHaveLength(1);
  });

  test("forgets the session on a session-ending close code", (): void => {
    const { gateway, first } = started();
    hello(first);
    ready(first);

    first.dispatchEvent(new CloseEvent("close", { code: 4009 }));
    jest.advanceTimersByTime(1_000);

    expect(FakeWebSocket.opened[1]!.url).toStartWith(
      "wss://gateway.discord.gg",
    );
    gateway.stop();
  });

  test("keeps the session on an ordinary close code", (): void => {
    const { gateway, first } = started();
    hello(first);
    ready(first);

    first.dispatchEvent(new CloseEvent("close", { code: 1006 }));
    jest.advanceTimersByTime(1_000);

    expect(FakeWebSocket.opened[1]!.url).toStartWith(RESUME_URL);
    gateway.stop();
  });

  test("stays stopped when a close arrives after stop", (): void => {
    const { gateway, first } = started();
    gateway.stop();

    first.dispatchEvent(new CloseEvent("close", { code: 1006 }));

    expect(gateway.state).toBe("stopped");
  });
});

describe("dial", (): void => {
  test("holds off while the identify budget is spent", (): void => {
    const gateway = gatewaySocket(undefined, 0);

    gateway.start();

    expect(gateway.state).toBe("exhausted");
    expect(FakeWebSocket.opened).toHaveLength(0);
    gateway.stop();
  });

  test("survives a frame that is not JSON", (): void => {
    const { gateway, first } = started();

    first.dispatchEvent(new MessageEvent("message", { data: "{not json" }));

    expect(gateway.state).toBe("connecting");
    gateway.stop();
  });

  test("closes the socket on a socket error", (): void => {
    const { gateway, first } = started();

    first.dispatchEvent(new Event("error"));

    expect(first.closeCode).toBe(1000);
    gateway.stop();
  });

  test("gives up on a socket that never becomes ready", (): void => {
    const { gateway, first } = started();

    jest.advanceTimersByTime(30_000);

    expect(first.closeCode).toBe(4000);
    expect(gateway.state).toBe("backoff");
    gateway.stop();
  });
});
