import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  cleanupTerminalSocket,
  openTerminalUpstream,
  relayTerminalInput,
  type RelayGatewayData,
} from "../../../../apps/gateway/src/terminal.ts";
import { MACHINE_MAX_FRAME_BYTES } from "../../../../apps/core/src/shared/machine-socket.ts";

type RelaySocket = Bun.ServerWebSocket<RelayGatewayData>;

interface Relay {
  socket: RelaySocket;
  sent: unknown[];
  closes: Array<[number, string]>;
  state: { readyState: number };
  flags: { failSend: boolean };
}

interface FakeUpstream {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  sentChunks: unknown[];
  closeCalls: Array<[number, string]>;
  failClose: boolean;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send: (chunk: unknown) => void;
  close: (code: number, reason: string) => void;
}

// Plain objects only: the recorder marks class instances and getters opaque.
const FakeUpstreamState: {
  instances: FakeUpstream[];
  failConstruct: boolean;
  OPEN: number;
  CLOSED: number;
} = { instances: [], failConstruct: false, OPEN: 1, CLOSED: 3 };

const FakeUpstream = Object.assign(
  function (): FakeUpstream {
    if (FakeUpstreamState.failConstruct) throw new Error("bad url");
    const fake: FakeUpstream = {
      readyState: 0,
      bufferedAmount: 0,
      binaryType: "",
      sentChunks: [],
      closeCalls: [],
      failClose: false,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (chunk: unknown): void => {
        fake.sentChunks.push(chunk);
      },
      close: (code: number, reason: string): void => {
        if (fake.failClose) throw new Error("close failed");
        fake.closeCalls.push([code, reason]);
        fake.readyState = FakeUpstreamState.CLOSED;
      },
    };
    FakeUpstreamState.instances.push(fake);

    return fake;
  },
  { OPEN: 1, CLOSED: 3 },
);

const originalWebSocket = globalThis.WebSocket;

function relay(kind: "machine" | "terminal"): Relay {
  const sent: unknown[] = [];
  const closes: Array<[number, string]> = [];
  const flags = { failSend: false };
  const socket = {
    readyState: 1,
    data: {
      kind: kind,
      ticket: {
        url: "ws://sandbox.example/pty",
        authorization: "Bearer sandbox-token",
        accountId: "acct_1",
        expiresAt: Date.now() + 60_000,
      },
    },
    send: (value: unknown): void => {
      if (flags.failSend) throw new Error("send failed");
      sent.push(value);
    },
    close: (code: number, reason: string): void => {
      closes.push([code, reason]);
    },
  } as unknown as RelaySocket;

  return {
    socket: socket,
    sent: sent,
    closes: closes,
    state: socket as unknown as { readyState: number },
    flags: flags,
  };
}

function upstream(): FakeUpstream {
  return FakeUpstreamState.instances.at(-1) as FakeUpstream;
}

beforeEach((): void => {
  FakeUpstreamState.instances = [];
  FakeUpstreamState.failConstruct = false;
  globalThis.WebSocket = FakeUpstream as unknown as typeof WebSocket;
});

afterEach((): void => {
  globalThis.WebSocket = originalWebSocket;
});

describe("openTerminalUpstream", (): void => {
  test("closes the browser when the dial throws", (): void => {
    FakeUpstreamState.failConstruct = true;
    const { socket, closes } = relay("terminal");
    openTerminalUpstream(socket);

    expect(closes).toEqual([[1011, "failed to reach the sandbox terminal"]]);
  });

  test("flushes queued input once the upstream opens", (): void => {
    const { socket } = relay("terminal");
    openTerminalUpstream(socket);
    relayTerminalInput(socket, "ls\n");
    relayTerminalInput(socket, Buffer.from("pwd"));
    upstream().onopen?.();

    expect(upstream().sentChunks).toEqual([
      "ls\n",
      new Uint8Array(Buffer.from("pwd")),
    ]);
  });

  test("relays text and binary frames, skipping a first session_init", (): void => {
    const { socket, sent } = relay("terminal");
    openTerminalUpstream(socket);
    upstream().onmessage?.({ data: '{"type":"session_init"}' });
    upstream().onmessage?.({ data: new Uint8Array([104, 105]).buffer });
    upstream().onmessage?.({ data: "text" });

    expect(sent).toEqual([new Uint8Array([104, 105]), "text"]);
  });

  test("passes a first frame that is not session_init", (): void => {
    const { socket, sent } = relay("terminal");
    openTerminalUpstream(socket);
    upstream().onmessage?.({ data: "$ " });

    expect(sent).toEqual(["$ "]);
  });

  test("ignores frames after the browser left, and send failures", (): void => {
    const { socket, sent, state, flags } = relay("terminal");
    openTerminalUpstream(socket);
    flags.failSend = true;
    upstream().onmessage?.({ data: "lost" });
    flags.failSend = false;
    state.readyState = 3;
    upstream().onmessage?.({ data: "late" });

    expect(sent).toEqual([]);
  });

  test("keeps a machine socket's close code on a clean upstream close", (): void => {
    const { socket, closes } = relay("machine");
    openTerminalUpstream(socket);
    upstream().onclose?.({ code: 1000, reason: "bye" });

    expect(closes).toEqual([[1000, "bye"]]);
  });

  test("maps an app close code through", (): void => {
    const { socket, closes } = relay("terminal");
    openTerminalUpstream(socket);
    upstream().onclose?.({ code: 4410, reason: "kicked" });

    expect(closes).toEqual([[4410, "kicked"]]);
  });

  test("does not close a browser that already left", (): void => {
    const { socket, closes, state } = relay("terminal");
    openTerminalUpstream(socket);
    state.readyState = 3;
    upstream().onclose?.({ code: 1011, reason: "x" });
    upstream().onerror?.();

    expect(closes).toEqual([]);
  });

  test("closes a terminal on a transport error but not a machine", (): void => {
    const terminal = relay("terminal");
    openTerminalUpstream(terminal.socket);
    upstream().onerror?.();
    const machine = relay("machine");
    openTerminalUpstream(machine.socket);
    upstream().onerror?.();

    expect(terminal.closes).toEqual([
      [1011, "sandbox terminal transport error"],
    ]);
    expect(machine.closes).toEqual([]);
  });
});

describe("relayTerminalInput", (): void => {
  test("closes when the upstream is not draining", (): void => {
    const { socket, closes } = relay("terminal");
    openTerminalUpstream(socket);
    upstream().readyState = FakeUpstreamState.OPEN;
    upstream().bufferedAmount = 2 * MACHINE_MAX_FRAME_BYTES + 1;
    relayTerminalInput(socket, "ls\n");

    expect(closes).toEqual([[1009, "terminal upstream is not draining"]]);
    expect(upstream().sentChunks).toEqual([]);
  });
});

describe("cleanupTerminalSocket", (): void => {
  test("does nothing for a socket that never opened", (): void => {
    const { socket, closes } = relay("terminal");
    cleanupTerminalSocket(socket);

    expect(closes).toEqual([]);
  });

  test("survives an upstream that fails to close", (): void => {
    const { socket } = relay("terminal");
    openTerminalUpstream(socket);
    upstream().readyState = FakeUpstreamState.OPEN;
    upstream().failClose = true;
    cleanupTerminalSocket(socket);
    relayTerminalInput(socket, "after");

    expect(upstream().closeCalls).toEqual([]);
    expect(upstream().sentChunks).toEqual([]);
  });
});
