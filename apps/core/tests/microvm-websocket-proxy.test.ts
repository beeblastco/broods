import { afterEach, describe, expect, test } from "bun:test";
import {
  MicrovmWebSocketProxy,
  microvmWebSocketProtocols,
} from "../src/harness/sandbox/microvm-websocket-proxy.ts";

const SECRET_TOKEN = "secret-token-that-must-stay-server-side";
const openedProxies: MicrovmWebSocketProxy[] = [];
const openedServers: Bun.Server<unknown>[] = [];

afterEach(async () => {
  await Promise.all(openedProxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(openedServers.splice(0).map((server) => server.stop(true)));
});

describe("MicrovmWebSocketProxy", () => {
  test("bridges a Harness WebSocket through AWS auth subprotocols without exposing the token", async () => {
    const upstreamRequest = Promise.withResolvers<{
      protocols: string;
      path: string;
    }>();
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url);
        upstreamRequest.resolve({
          protocols: request.headers.get("sec-websocket-protocol") ?? "",
          path: `${url.pathname}${url.search}`,
        });
        return server.upgrade(request, {
          headers: { "Sec-WebSocket-Protocol": "lambda-microvms" },
        })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message(socket, message) {
          socket.send(message);
        },
      },
    });
    openedServers.push(upstream);

    const proxy = new MicrovmWebSocketProxy({
      endpoint: `ws://127.0.0.1:${upstream.port}/ignored`,
      microvmId: "mvm-test-123",
      allowedPorts: [4_321],
      allowInsecureUpstream: true,
      async createAuthToken(microvmId, port) {
        expect(microvmId).toBe("mvm-test-123");
        expect(port).toBe(4_321);
        return SECRET_TOKEN;
      },
    });
    openedProxies.push(proxy);

    const proxyUrl = proxy.getPortUrl(4_321);
    expect(proxyUrl).toStartWith("ws://127.0.0.1:");
    expect(proxyUrl).not.toContain(SECRET_TOKEN);
    expect(proxyUrl).not.toContain("mvm-test-123");
    expect(proxyUrl).not.toContain("ignored");

    const echoed = await websocketRoundTrip(
      `${proxyUrl}?agent_bridge_token=bridge-only-token`,
      "hello through proxy",
    );
    expect(echoed).toBe("hello through proxy");

    const observed = await withTimeout(upstreamRequest.promise);
    expect(observed.path).toBe("/?agent_bridge_token=bridge-only-token");
    expect(observed.protocols.split(",").map((value) => value.trim())).toEqual(
      microvmWebSocketProtocols(SECRET_TOKEN, 4_321),
    );
  });

  test("only creates opaque routes for declared ports", () => {
    const proxy = new MicrovmWebSocketProxy({
      endpoint: "wss://example.lambda-microvm.us-east-1.on.aws",
      microvmId: "mvm-test-123",
      allowedPorts: [4_321],
      async createAuthToken() {
        return SECRET_TOKEN;
      },
    });
    openedProxies.push(proxy);

    expect(proxy.getPortUrl(4_321)).toBe(proxy.getPortUrl(4_321));
    expect(() => proxy.getPortUrl(4_322)).toThrow("port 4322 was not declared");
    expect(() => proxy.getPortUrl(0)).toThrow("port is invalid");
  });

  test("closes generically when token minting fails", async () => {
    const proxy = new MicrovmWebSocketProxy({
      endpoint: "wss://example.lambda-microvm.us-east-1.on.aws",
      microvmId: "mvm-test-123",
      allowedPorts: [4_321],
      async createAuthToken() {
        throw new Error(`credential failure: ${SECRET_TOKEN}`);
      },
    });
    openedProxies.push(proxy);

    const result = await websocketClose(proxy.getPortUrl(4_321));
    expect(result.code).toBe(1011);
    expect(result.reason).toBe("MicroVM bridge unavailable");
    expect(result.reason).not.toContain(SECRET_TOKEN);
  });
});

function websocketRoundTrip(url: string, message: string): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(url);
      let response: string | undefined;
      socket.addEventListener("open", () => socket.send(message));
      socket.addEventListener("message", (event) => {
        response = String(event.data);
        socket.close();
      });
      socket.addEventListener("close", () => {
        if (response !== undefined) resolve(response);
      });
      socket.addEventListener("error", () =>
        reject(new Error("WebSocket round trip failed")),
      );
    }),
  );
}

function websocketClose(
  url: string,
): Promise<{ code: number; reason: string }> {
  return withTimeout(
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason }),
      );
      socket.addEventListener("error", () => {
        if (socket.readyState !== WebSocket.CLOSED) {
          reject(new Error("WebSocket failed before close"));
        }
      });
    }),
  );
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(5_000).then(() => {
      throw new Error("Timed out waiting for WebSocket test");
    }),
  ]);
}
