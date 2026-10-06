import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { ForwarderConfig } from "../src/config.ts";
import { GatewayOpcode, type GatewayPayload } from "../src/discord.ts";
import { IdentifyBudget } from "../src/identify-budget.ts";
import { GatewaySocket } from "../src/socket.ts";

const CONFIG: ForwarderConfig = {
  backoffCeilingMs: 300_000,
  identifyLimit: 10,
  planes: [],
  port: 3000,
};

const HEARTBEAT_INTERVAL_MS = 40_000;
// The jittered first beat, the beat that finds it unacknowledged, and the
// first reconnect backoff, which never exceeds a second.
const UNTIL_REDIAL_MS = HEARTBEAT_INTERVAL_MS * 2 + 1_000;

const realWebSocket = globalThis.WebSocket;

/** Stands in for the global WebSocket. It never delivers close on its own. */
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
  // Heartbeat jitter and backoff both draw from it; pinned so the timing
  // windows below hold on every run.
  jest.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach((): void => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  globalThis.WebSocket = realWebSocket;
});

describe("gateway socket", (): void => {
  // A partitioned socket may never deliver its close event, so waiting on it
  // would leave the token silent for the life of the process.
  it("re-dials after an unacknowledged heartbeat without a close event", (): void => {
    const { gateway, first } = readySocket();

    jest.advanceTimersByTime(UNTIL_REDIAL_MS);

    expect(first.closeCode).toBe(4000);
    expect(FakeWebSocket.opened).toHaveLength(2);
    expect(FakeWebSocket.opened[1]!.url).toStartWith(
      "wss://gateway-us-east1-b.discord.gg",
    );
    gateway.stop();
  });

  it("ignores the late close event of a socket it already abandoned", (): void => {
    const { gateway, first } = readySocket();
    jest.advanceTimersByTime(UNTIL_REDIAL_MS);

    first.dispatchEvent(new CloseEvent("close", { code: 4000 }));

    expect(gateway.state).toBe("connecting");
    expect(FakeWebSocket.opened).toHaveLength(2);
    gateway.stop();
  });

  it("jitters the first heartbeat inside one interval", (): void => {
    jest.spyOn(Math, "random").mockReturnValue(0.25);
    const { gateway, first } = readySocket();
    const beats = (): number =>
      first.sent.filter(
        (payload): boolean => payload.op === GatewayOpcode.Heartbeat,
      ).length;

    jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 0.25 - 1);
    expect(beats()).toBe(0);
    jest.advanceTimersByTime(1);
    expect(beats()).toBe(1);
    gateway.stop();
  });

  it("resumes after a resumable INVALID_SESSION, waiting at least a second", (): void => {
    const { gateway, first } = readySocket();

    first.receive({ op: GatewayOpcode.InvalidSession, d: true });
    jest.advanceTimersByTime(999);
    expect(FakeWebSocket.opened).toHaveLength(1);
    jest.advanceTimersByTime(4_001);

    const second = FakeWebSocket.opened[1]!;
    expect(second.url).toStartWith("wss://gateway-us-east1-b.discord.gg");
    second.receive({ op: GatewayOpcode.Hello, d: { heartbeat_interval: 1 } });
    expect(second.sent[0]!.op).toBe(GatewayOpcode.Resume);
    gateway.stop();
  });

  it("identifies afresh after a non-resumable INVALID_SESSION", (): void => {
    const { gateway, first } = readySocket();

    first.receive({ op: GatewayOpcode.InvalidSession, d: false });
    jest.advanceTimersByTime(5_000);

    const second = FakeWebSocket.opened[1]!;
    expect(second.url).toStartWith("wss://gateway.discord.gg");
    second.receive({ op: GatewayOpcode.Hello, d: { heartbeat_interval: 1 } });
    expect(second.sent[0]!.op).toBe(GatewayOpcode.Identify);
    gateway.stop();
  });
});

/** A socket past READY on its first connection, with its session known. */
function readySocket(): { gateway: GatewaySocket; first: FakeWebSocket } {
  const gateway = new GatewaySocket({
    botToken: "token-a",
    budget: new IdentifyBudget(CONFIG.identifyLimit),
    config: CONFIG,
    onMessageCreate: (): void => {},
  });
  gateway.start();
  const first = FakeWebSocket.opened[0]!;
  first.receive({
    op: GatewayOpcode.Hello,
    d: { heartbeat_interval: HEARTBEAT_INTERVAL_MS },
  });
  first.receive({
    op: GatewayOpcode.Dispatch,
    s: 1,
    t: "READY",
    d: {
      resume_gateway_url: "wss://gateway-us-east1-b.discord.gg",
      session_id: "session-1",
      user: { id: "bot-1", username: "bot" },
    },
  });

  return { gateway: gateway, first: first };
}
