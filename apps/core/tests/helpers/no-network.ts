// Test preload (bunfig.toml): fetch, preconnect and sockets may only reach loopback.
// Sockets too, since node:http SDKs (Slack's axios WebClient) never touch fetch.

import { afterAll, afterEach, beforeAll } from "bun:test";
import net from "node:net";
import { inFlightForTests } from "../../src/shared/in-flight.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const realFetch = globalThis.fetch;

globalThis.fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    assertLoopback(new URL(input instanceof Request ? input.url : input).host);

    return realFetch(input, init);
  },
  {
    preconnect: (...args: Parameters<typeof fetch.preconnect>): void => {
      assertLoopback(new URL(args[0]).host);
      realFetch.preconnect(...args);
    },
  },
);

// node:http, node:https and node:tls connect through here; a string arg is a Unix socket.
// oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below calls it on the socket
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (
  this: net.Socket,
  ...args: [net.SocketConnectOpts | number | string, ...unknown[]]
): net.Socket {
  const [first, second] = args;
  const host =
    typeof first === "number"
      ? typeof second === "string"
        ? second
        : "localhost"
      : typeof first === "string"
        ? "localhost"
        : "path" in first
          ? "localhost"
          : (first.host ?? "localhost");
  try {
    assertLoopback(host);
  } catch (error) {
    // Fail the way a refused connection does: asynchronously, on the socket.
    process.nextTick((): void => {
      this.destroy(error instanceof Error ? error : undefined);
    });

    return this;
  }

  return Reflect.apply(realConnect, this, args) as net.Socket;
} as typeof realConnect;

const guardedFetch = globalThis.fetch;
// oxlint-disable-next-line typescript/unbound-method -- restored onto the prototype below
const guardedConnect = net.Socket.prototype.connect;

export function allowNetwork(): void {
  beforeAll((): void => {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
  });
  afterAll((): void => {
    globalThis.fetch = guardedFetch;
    net.Socket.prototype.connect = guardedConnect;
  });
}

// waitUntil work left running (a Convex write retrying for 30 s) stalls a later file's
// drain, so the test that started it fails instead, once per task.
const reportedInFlight = new WeakSet<Promise<void>>();
afterEach(async (): Promise<void> => {
  await new Promise<void>((resolve): void => {
    setImmediate(resolve);
  });
  const leaked = [...inFlightForTests()].filter(
    (task): boolean => !reportedInFlight.has(task),
  );
  for (const task of leaked) {
    reportedInFlight.add(task);
  }
  if (leaked.length > 0) {
    throw new Error(
      `This test left ${leaked.length} waitUntil task(s) running; stub what it calls so nothing outlives the test`,
    );
  }
});

function assertLoopback(host: string): void {
  const hostname = host.replace(/:\d+$/, "");
  if (!LOOPBACK_HOSTS.has(hostname) && !LOOPBACK_HOSTS.has(host)) {
    throw new TypeError(
      `Unit tests must not reach ${host}; stub globalThis.fetch or the SDK client`,
    );
  }
}
