/**
 * Test preload (bunfig.toml) that keeps unit tests off the network: any fetch,
 * preconnect or socket that a test has not stubbed and that leaves loopback
 * fails like an unreachable host, so a missing stub can never reach a real
 * provider API. Sockets are covered because SDKs on node:http (Slack's axios
 * WebClient) never touch fetch. It also fails a test that leaves waitUntil
 * work running, since that work outlives the test inside the shared process.
 */

import { afterEach } from "bun:test";
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

// node:http, node:https and node:tls all open their connection through here. A
// string first argument is a Unix socket path, which never leaves the machine.
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

/**
 * Lifts the guard for the whole process. Only the opt-in live suites call it,
 * when enabled, because they must reach a real provider; run them on their own.
 */
export function allowNetwork(): void {
  globalThis.fetch = realFetch;
  net.Socket.prototype.connect = realConnect;
}

// Work a test hands to waitUntil and leaves running (a real Convex write
// retrying for half a minute) stalls a later file's drain, so the test that
// started it fails here instead. Each task fails one test, never a cascade.
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

// Throws for any host the guarded fetch, preconnect or socket may not open.
function assertLoopback(host: string): void {
  const hostname = host.replace(/:\d+$/, "");
  if (!LOOPBACK_HOSTS.has(hostname) && !LOOPBACK_HOSTS.has(host)) {
    throw new TypeError(
      `Unit tests must not reach ${host}; stub globalThis.fetch or the SDK client`,
    );
  }
}
