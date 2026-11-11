import { afterEach, describe, expect, test } from "bun:test";

import { MicrovmWebSocketProxy } from "../../../../apps/core/src/harness/sandbox/microvm-websocket-proxy.ts";

const openedProxies: MicrovmWebSocketProxy[] = [];
const openedServers: Bun.Server<unknown>[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(
    openedProxies.splice(0).map((proxy): Promise<void> => proxy.close()),
  );
  await Promise.all(
    openedServers.splice(0).map((server): Promise<void> => server.stop(true)),
  );
});

function proxyTo(
  endpoint: string,
  allowInsecureUpstream: boolean,
): MicrovmWebSocketProxy {
  const proxy = new MicrovmWebSocketProxy({
    endpoint: endpoint,
    microvmId: "mvm-test-1",
    allowedPorts: [4_321],
    allowInsecureUpstream: allowInsecureUpstream,
    createAuthToken: async (): Promise<string> => "token-for-test",
  });
  openedProxies.push(proxy);

  return proxy;
}

function echoServer(): Bun.Server<unknown> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: function (request, upgrading): Response | undefined {
      return upgrading.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": "lambda-microvms" },
      })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message: function (socket, message): void {
        socket.send(message);
      },
    },
  });
  openedServers.push(server);

  return server;
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject): void => {
    timer = setTimeout((): void => reject(new Error("timed out")), 5_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe("sendUpstreamMessage", (): void => {
  test("binary frames from the MicroVM reach the harness as bytes", async (): Promise<void> => {
    const server = echoServer();
    const proxy = proxyTo(`ws://127.0.0.1:${server.port}/`, true);

    const echoed = await withTimeout(
      new Promise<Uint8Array>((resolve, reject): void => {
        const socket = new WebSocket(proxy.getPortUrl(4_321));
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", (): void =>
          socket.send(new Uint8Array([1, 2, 3])),
        );
        socket.addEventListener("message", (event): void => {
          resolve(new Uint8Array(event.data as ArrayBuffer));
          socket.close();
        });
        socket.addEventListener("error", (): void =>
          reject(new Error("round trip failed")),
        );
      }),
    );

    expect([...echoed]).toEqual([1, 2, 3]);
  });
});

describe("microvmUpstreamUrl", (): void => {
  test("an insecure upstream must be loopback ws", async (): Promise<void> => {
    const proxy = proxyTo("wss://example.com/", true);

    const closed = await withTimeout(
      new Promise<{ code: number; reason: string }>((resolve): void => {
        const socket = new WebSocket(proxy.getPortUrl(4_321));
        socket.addEventListener("close", (event): void =>
          resolve({ code: event.code, reason: event.reason }),
        );
      }),
    );

    expect(closed).toEqual({
      code: 1011,
      reason: "MicroVM bridge unavailable",
    });
  });
});
