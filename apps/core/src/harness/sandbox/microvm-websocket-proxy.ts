/**
 * Loopback-only WebSocket bridge for AWS Lambda MicroVM application ports.
 *
 * Harness adapters accept only a URL and open their own bare WebSocket. Lambda
 * MicroVM ingress instead requires authentication and port metadata in WebSocket
 * subprotocols. This proxy keeps the AWS token server-side, forwards only the
 * bridge path/query to the guest, and exposes an unguessable localhost route.
 */

import { randomBytes } from "node:crypto";

const MAX_QUEUED_BYTES = 1024 * 1024;
const MAX_WEBSOCKET_PAYLOAD_BYTES = 16 * 1024 * 1024;
const AWS_ENDPOINT_PATTERN = /\.lambda-microvm(?:\.[a-z0-9-]+)?\.on\.aws$/i;

interface MicrovmProxyRoute {
  endpoint: string;
  microvmId: string;
  port: number;
}

interface MicrovmProxySocketData {
  routeId: string;
  search: string;
  upstream?: WebSocket;
  queued: Array<string | Uint8Array>;
  queuedBytes: number;
  closed: boolean;
}

export interface MicrovmWebSocketProxyOptions {
  endpoint: string;
  microvmId: string;
  allowedPorts: ReadonlyArray<number>;
  createAuthToken: (microvmId: string, port: number) => Promise<string>;
  /** Test-only escape hatch for a loopback `ws://` upstream. */
  allowInsecureUpstream?: boolean;
}

export class MicrovmWebSocketProxy {
  readonly #options: MicrovmWebSocketProxyOptions;
  readonly #routes = new Map<string, MicrovmProxyRoute>();
  readonly #routesByPort = new Map<number, string>();
  readonly #connections = new Set<
    Bun.ServerWebSocket<MicrovmProxySocketData>
  >();
  #server: Bun.Server<MicrovmProxySocketData> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: MicrovmWebSocketProxyOptions) {
    this.#options = options;
  }

  getPortUrl(port: number): string {
    this.#assertAllowedPort(port);
    const server = this.#server ?? this.#start();
    let routeId = this.#routesByPort.get(port);
    if (!routeId) {
      routeId = randomBytes(32).toString("base64url");
      this.#routesByPort.set(port, routeId);
      this.#routes.set(routeId, {
        endpoint: this.#options.endpoint,
        microvmId: this.#options.microvmId,
        port: port,
      });
    }

    return `ws://127.0.0.1:${server.port}/bridge/${routeId}`;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();

    return this.#closePromise;
  }

  #assertAllowedPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`MicroVM Harness port is invalid: ${port}`);
    }
    if (!this.#options.allowedPorts.includes(port)) {
      throw new Error(`MicroVM Harness port ${port} was not declared`);
    }
  }

  #start(): Bun.Server<MicrovmProxySocketData> {
    const server = Bun.serve<MicrovmProxySocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, bunServer) => {
        const url = new URL(request.url);
        const routeId = url.pathname.match(/^\/bridge\/([^/]+)$/)?.[1];
        if (
          request.method !== "GET" ||
          request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
          !routeId ||
          !this.#routes.has(routeId)
        ) {
          return new Response("Not found", { status: 404 });
        }
        const upgraded = bunServer.upgrade(request, {
          data: {
            routeId: routeId,
            search: url.search,
            queued: [],
            queuedBytes: 0,
            closed: false,
          },
        });

        return upgraded
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 400 });
      },
      websocket: {
        maxPayloadLength: MAX_WEBSOCKET_PAYLOAD_BYTES,
        backpressureLimit: MAX_QUEUED_BYTES,
        closeOnBackpressureLimit: true,
        open: (socket) => {
          this.#connections.add(socket);
          void this.#connectUpstream(socket);
        },
        message: (socket, message) => {
          const payload =
            typeof message === "string"
              ? message
              : new Uint8Array(
                  message.buffer,
                  message.byteOffset,
                  message.byteLength,
                );
          const upstream = socket.data.upstream;
          if (upstream?.readyState === WebSocket.OPEN) {
            upstream.send(payload);

            return;
          }
          const bytes =
            typeof payload === "string"
              ? Buffer.byteLength(payload)
              : payload.byteLength;
          socket.data.queuedBytes += bytes;
          if (socket.data.queuedBytes > MAX_QUEUED_BYTES) {
            socket.close(1009, "Proxy queue limit exceeded");

            return;
          }
          socket.data.queued.push(payload);
        },
        close: (socket, code, reason) => {
          socket.data.closed = true;
          this.#connections.delete(socket);
          const upstream = socket.data.upstream;
          if (
            upstream &&
            (upstream.readyState === WebSocket.OPEN ||
              upstream.readyState === WebSocket.CONNECTING)
          ) {
            upstream.close(validCloseCode(code), reason);
          }
        },
      },
    });
    this.#server = server;

    return server;
  }

  async #connectUpstream(
    socket: Bun.ServerWebSocket<MicrovmProxySocketData>,
  ): Promise<void> {
    const route = this.#routes.get(socket.data.routeId);
    if (!route || socket.data.closed) {
      socket.close(1008, "Proxy route expired");

      return;
    }

    try {
      const token = await this.#options.createAuthToken(
        route.microvmId,
        route.port,
      );
      if (socket.data.closed) return;
      const upstream = new WebSocket(
        microvmUpstreamUrl(
          route.endpoint,
          socket.data.search,
          this.#options.allowInsecureUpstream === true,
        ),
        microvmWebSocketProtocols(token, route.port),
      );
      upstream.binaryType = "arraybuffer";
      socket.data.upstream = upstream;
      upstream.addEventListener("open", () => {
        if (socket.data.closed) {
          upstream.close(1000, "Client closed");

          return;
        }
        for (const message of socket.data.queued) upstream.send(message);
        socket.data.queued = [];
        socket.data.queuedBytes = 0;
      });
      upstream.addEventListener("message", (event) => {
        if (socket.data.closed) return;
        void sendUpstreamMessage(socket, event.data);
      });
      upstream.addEventListener("close", (event) => {
        if (!socket.data.closed) {
          socket.close(validCloseCode(event.code), "MicroVM bridge closed");
        }
      });
      upstream.addEventListener("error", () => {
        if (!socket.data.closed)
          socket.close(1011, "MicroVM bridge unavailable");
      });
    } catch {
      if (!socket.data.closed) socket.close(1011, "MicroVM bridge unavailable");
    }
  }

  async #close(): Promise<void> {
    this.#routes.clear();
    this.#routesByPort.clear();
    for (const socket of this.#connections) {
      socket.data.closed = true;
      socket.data.upstream?.close(1001, "Harness session closed");
      socket.close(1001, "Harness session closed");
    }
    this.#connections.clear();
    const server = this.#server;
    this.#server = undefined;
    // Bun 1.3 can leave the `stop(true)` promise pending after a server-initiated
    // WebSocket close even though the listener has already stopped. Invoking the
    // forced stop is sufficient; awaiting that promise would hang Harness cleanup.
    if (server) void server.stop(true);
  }
}

export function microvmWebSocketProtocols(
  token: string,
  port: number,
): string[] {
  return [
    "lambda-microvms",
    `lambda-microvms.authentication.${token}`,
    `lambda-microvms.port.${port}`,
  ];
}

function microvmUpstreamUrl(
  endpoint: string,
  search: string,
  allowInsecure: boolean,
): string {
  const raw = /^[a-z]+:\/\//i.test(endpoint) ? endpoint : `wss://${endpoint}`;
  const url = new URL(raw);
  if (allowInsecure) {
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") {
      throw new Error("Insecure MicroVM proxy upstream must be loopback ws");
    }
  } else if (
    url.protocol !== "wss:" ||
    !AWS_ENDPOINT_PATTERN.test(url.hostname)
  ) {
    throw new Error("MicroVM proxy upstream is not an AWS MicroVM endpoint");
  }
  url.pathname = "/";
  url.search = search;
  url.hash = "";

  return url.toString();
}

async function sendUpstreamMessage(
  socket: Bun.ServerWebSocket<MicrovmProxySocketData>,
  data: unknown,
): Promise<void> {
  if (typeof data === "string") {
    socket.send(data);
  } else if (data instanceof ArrayBuffer) {
    socket.send(new Uint8Array(data));
  } else if (data instanceof Blob) {
    socket.send(new Uint8Array(await data.arrayBuffer()));
  } else if (ArrayBuffer.isView(data)) {
    socket.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
}

function validCloseCode(code: number): number {
  return code >= 1000 && code <= 4999 ? code : 1011;
}
