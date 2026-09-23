import {
  connectNats,
  type NatsConnection,
} from "../../core/src/shared/nats.ts";
import {
  MACHINE_MAX_FRAME_BYTES,
  MACHINE_WEBSOCKET_PATH,
  machineSocketUrl,
} from "../../core/src/shared/machine-socket.ts";
import { requireSecretsEnv } from "../../core/src/shared/env.ts";
import { TERMINAL_WEBSOCKET_PATH } from "../../core/src/shared/terminal-ticket.ts";
import {
  handleAgentMessage,
  stopActiveRun,
  type AgentTestGatewayData,
} from "./agent.ts";
import {
  cleanupObservabilitySocket,
  handleObservabilityMessage,
  openObservabilitySocket,
  type ObservabilityGatewayData,
} from "./observability.ts";
import {
  cleanupTerminalSocket,
  openTerminalTicketWithSecrets,
  openTerminalUpstream,
  relayTerminalInput,
  type MachineGatewayData,
  type RelayGatewayData,
  type TerminalGatewayData,
} from "./terminal.ts";
import {
  isConfigHttpPath,
  isCoreHttpRoute,
  isInternalCorePath,
  matchAgentWebSocketPath,
  matchObservabilityWebSocketPath,
} from "./routes.ts";
import { RateLimiter } from "./rate-limiter.ts";
import {
  proxyHttp,
  resolveSocketScope,
  type ProxyOptions,
} from "./upstream.ts";
import {
  allowedOriginPatternsFromEnv,
  clientIp,
  corsHeaders,
  gatewayLimitsFromEnv,
  isOriginAllowed,
  json,
  jsonError,
  normalizeBaseUrl,
  normalizedCoreBaseUrls,
  rateLimitHeaders,
  resolveRequestId,
  warnDeprecatedQueryToken,
  websocketToken,
  websocketUpgradeHeaders,
  withCors,
  withRequestId,
  type GatewayLimits,
} from "./utils.ts";

export type GatewayData =
  | AgentTestGatewayData
  | MachineGatewayData
  | ObservabilityGatewayData
  | TerminalGatewayData;

let natsConnectionPromise: Promise<NatsConnection> | null = null;

/** Everything the router reads that the process environment decides. */
export interface GatewayConfig {
  allowedOrigins: string[];
  authFailureLimiter: RateLimiter;
  configBaseUrl: string | undefined;
  coreBaseUrls: string[];
  denyInternalPaths: boolean;
  httpLimiter: RateLimiter | undefined;
  limits: GatewayLimits;
  proxyOptions: ProxyOptions;
  terminalTicketSecrets: string[];
  upgradeLimiter: RateLimiter;
}

/** The two halves `Bun.serve` needs, built over one resolved config. */
export interface GatewayRuntime {
  /** Closes every open socket, for a shutdown. */
  closeSockets: (code: number, reason: string) => void;
  fetch: (
    request: Request,
    server: Bun.Server<GatewayData>,
  ) => Promise<Response | undefined>;
  websocket: Bun.WebSocketHandler<GatewayData>;
}

/**
 * Build the router and socket handlers over one config.
 *
 * The security ordering lives here rather than inside the `import.meta.main`
 * block so tests can drive it without binding a port: origin allowlist, upgrade
 * rate limit, auth-failure rate limit, capacity, then the per-path token and
 * scope checks. The open sockets are per gateway, so two of them in one test
 * process do not share a capacity ceiling.
 */
export function createGateway(config: GatewayConfig): GatewayRuntime {
  const sockets = new Set<Bun.ServerWebSocket<GatewayData>>();
  let pendingUpgrades = 0;

  async function route(
    request: Request,
    server: Bun.Server<GatewayData>,
    requestId: string,
  ): Promise<Response | undefined> {
    const url = new URL(request.url);

    if (
      (url.pathname === "/" || url.pathname === "/healthz") &&
      request.method === "GET"
    ) {
      return json(
        {
          status: "ok",
          activeWebSockets: sockets.size,
          maxWebSockets: config.limits.maxConnections,
        },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    // Answer the browser's CORS preflight before the rate limiters and routing:
    // a preflight is not the real request and never reaches an upstream. A
    // disallowed origin gets no CORS headers, so the browser blocks it.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(
          request.headers.get("origin"),
          config.allowedOrigins,
          config.proxyOptions.forwardAccountId,
        ),
      });
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (
        !isOriginAllowed(request.headers.get("origin"), config.allowedOrigins)
      ) {
        return jsonError(403, "Origin is not allowed");
      }
      const ip = clientIp(request, server.requestIP(request)?.address);
      if (!config.upgradeLimiter.allow(ip)) {
        return jsonError(
          429,
          "Too many connection attempts",
          {},
          rateLimitHeaders(
            config.upgradeLimiter.limit,
            config.upgradeLimiter.retryAfterSeconds(ip),
          ),
        );
      }
      if (config.authFailureLimiter.blocked(ip)) {
        return jsonError(
          429,
          "Too many failed authentication attempts",
          {},
          rateLimitHeaders(
            config.authFailureLimiter.limit,
            config.authFailureLimiter.retryAfterSeconds(ip),
          ),
        );
      }
      // Upgrades still resolving a token count too, or a burst would all pass
      // the check before any of them opened.
      if (sockets.size + pendingUpgrades >= config.limits.maxConnections) {
        return jsonError(503, "Gateway is at capacity");
      }

      pendingUpgrades += 1;
      try {
        let data: GatewayData | undefined;
        const observabilityPath = matchObservabilityWebSocketPath(url.pathname);
        const agentWebSocketPath = matchAgentWebSocketPath(url.pathname);
        if (url.pathname === TERMINAL_WEBSOCKET_PATH) {
          const ticket = openTerminalTicketWithSecrets(
            websocketToken(request, url),
            config.terminalTicketSecrets,
          );
          // A bad ticket still upgrades: the open handler closes it with a code
          // and reason the browser can show, where a 401 here would be a mute 1006.
          if (!ticket) config.authFailureLimiter.allow(ip);
          data = { kind: "terminal", ticket: ticket };
        } else if (url.pathname === MACHINE_WEBSOCKET_PATH) {
          // Core checks the daemon's bearer and refuses with a close code.
          const token = websocketToken(request, url);
          if (!token) return jsonError(401, "Missing WebSocket token");

          data = {
            kind: "machine",
            ticket: {
              url: machineSocketUrl(config.coreBaseUrls[0]!),
              authorization: `Bearer ${token}`,
            },
          };
        } else if (observabilityPath || agentWebSocketPath) {
          warnDeprecatedQueryToken(request, url);
          const token = websocketToken(request, url);
          if (!token) return jsonError(401, "Missing WebSocket token");

          const resolved = await resolveSocketScope(token, config.coreBaseUrls);
          if (resolved.kind === "unavailable")
            return jsonError(502, "Could not verify the WebSocket token");
          if (resolved.kind === "invalid") {
            config.authFailureLimiter.allow(ip);

            return jsonError(401, "Invalid WebSocket token");
          }
          const { scope } = resolved;
          if (observabilityPath) {
            if (
              scope.projectSlug !== decodeURIComponent(observabilityPath[1]) ||
              scope.stageSlug !== decodeURIComponent(observabilityPath[2])
            ) {
              return jsonError(
                403,
                "WebSocket scope does not match the requested project/stage",
                { code: "scope_mismatch" },
              );
            }
            data = { kind: "observability", scope: scope };
          } else if (agentWebSocketPath) {
            // Bind the socket to the key's own endpoint scope: attach never posts
            // through the core run path, so the door check must happen here.
            if (
              !scope.endpointIds.includes(agentWebSocketPath.endpointId) ||
              (agentWebSocketPath.projectSlug !== undefined &&
                scope.projectSlug !== agentWebSocketPath.projectSlug) ||
              (agentWebSocketPath.stageSlug !== undefined &&
                scope.stageSlug !== agentWebSocketPath.stageSlug)
            ) {
              return jsonError(
                403,
                "WebSocket scope does not match the requested endpoint",
                { code: "scope_mismatch" },
              );
            }
            data = {
              kind: "agent-test",
              corePath: url.pathname.slice(0, -"/ws".length),
              token: token,
              coreBaseUrl: resolved.coreBaseUrl,
              accountId: scope.accountId,
            };
          }
        }
        if (data) {
          const upgraded = server.upgrade(request, {
            headers: websocketUpgradeHeaders(request),
            data: data,
          });

          return upgraded
            ? undefined
            : jsonError(400, "WebSocket upgrade failed");
        }
      } finally {
        pendingUpgrades -= 1;
      }
    }

    const requestIp = clientIp(request, server.requestIP(request)?.address);
    if (config.httpLimiter && !config.httpLimiter.allow(requestIp)) {
      return jsonError(
        429,
        "Too many requests",
        {},
        rateLimitHeaders(
          config.httpLimiter.limit,
          config.httpLimiter.retryAfterSeconds(requestIp),
        ),
      );
    }

    if (isConfigHttpPath(url.pathname, request.method)) {
      if (!config.configBaseUrl)
        return jsonError(
          503,
          "Config plane is not configured (BROODS_CONFIG_URL)",
        );

      return proxyHttp(request, [config.configBaseUrl], {
        ...config.proxyOptions,
        requestId: requestId,
      });
    }

    if (
      !isCoreHttpRoute(url.pathname) ||
      (config.denyInternalPaths && isInternalCorePath(url.pathname))
    )
      return jsonError(404, "Not found");

    return proxyHttp(request, config.coreBaseUrls, {
      ...config.proxyOptions,
      requestId: requestId,
    });
  }

  async function handleRequest(
    request: Request,
    server: Bun.Server<GatewayData>,
  ): Promise<Response | undefined> {
    const requestId = resolveRequestId(request.headers.get("x-request-id"));
    try {
      const response = await route(request, server, requestId);

      // A WebSocket upgrade returns undefined; there is no response to stamp.
      // A browser reads the response only when it carries the CORS headers for
      // its origin, so a cross-origin POST (the Continue button, the test chat)
      // sees the result instead of a bare "Failed to fetch".
      if (!response) return response;
      const origin = request.headers.get("origin");

      return withRequestId(
        withCors(
          response,
          origin,
          config.allowedOrigins,
          config.proxyOptions.forwardAccountId,
        ),
        requestId,
      );
    } catch (error) {
      // A malformed %-escape in a path segment is the caller's mistake.
      if (error instanceof URIError)
        return withRequestId(jsonError(400, "Malformed URL path"), requestId);
      console.error("gateway request failed:", {
        requestId: requestId,
        error: error,
      });

      return withRequestId(jsonError(500, "Internal gateway error"), requestId);
    }
  }

  const websocket: Bun.WebSocketHandler<GatewayData> = {
    // Bun takes one frame cap per server, so it is sized for the machine
    // socket and every other socket enforces the configured one in `message`.
    maxPayloadLength: Math.max(
      config.limits.maxPayloadBytes,
      MACHINE_MAX_FRAME_BYTES,
    ),
    backpressureLimit: config.limits.backpressureBytes,
    closeOnBackpressureLimit: true,
    idleTimeout: config.limits.idleTimeoutSeconds,
    open: function (socket): void {
      sockets.add(socket);
      if (socket.data.kind === "observability")
        openObservabilitySocket(
          socket as Bun.ServerWebSocket<ObservabilityGatewayData>,
        );
      if (socket.data.kind === "terminal" || socket.data.kind === "machine")
        openTerminalUpstream(socket as Bun.ServerWebSocket<RelayGatewayData>);
    },
    message: async function (socket, rawMessage): Promise<void> {
      if (
        socket.data.kind !== "machine" &&
        Buffer.byteLength(rawMessage) > config.limits.maxPayloadBytes
      ) {
        socket.close(1009, "message too big");

        return;
      }
      if (socket.data.kind === "terminal" || socket.data.kind === "machine") {
        relayTerminalInput(
          socket as Bun.ServerWebSocket<RelayGatewayData>,
          rawMessage,
        );

        return;
      }

      if (socket.data.kind === "observability") {
        await handleObservabilityMessage(
          socket as Bun.ServerWebSocket<ObservabilityGatewayData>,
          rawMessage,
          getNatsConnection,
        );

        return;
      }

      handleAgentMessage(
        socket as Bun.ServerWebSocket<AgentTestGatewayData>,
        rawMessage,
        config.limits,
        getNatsConnection,
      );
    },
    close: function (socket): void {
      sockets.delete(socket);
      if (socket.data.kind === "terminal" || socket.data.kind === "machine") {
        cleanupTerminalSocket(socket as Bun.ServerWebSocket<RelayGatewayData>);

        return;
      }
      if (socket.data.kind === "observability") {
        cleanupObservabilitySocket(
          socket as Bun.ServerWebSocket<ObservabilityGatewayData>,
        );

        return;
      }

      stopActiveRun(socket as Bun.ServerWebSocket<AgentTestGatewayData>);
    },
  };

  return {
    closeSockets: function (code: number, reason: string): void {
      for (const socket of sockets) socket.close(code, reason);
    },
    fetch: handleRequest,
    websocket: websocket,
  };
}

/** Resolve the router's config from the process environment. */
export function gatewayConfigFromEnv(): GatewayConfig {
  const httpRequestsPerMinute =
    Number(process.env.GATEWAY_HTTP_REQUESTS_PER_MINUTE ?? "") || 0;

  return {
    allowedOrigins: allowedOriginPatternsFromEnv(),
    authFailureLimiter: new RateLimiter(
      Number(process.env.GATEWAY_AUTH_FAILURES_PER_MINUTE ?? "") || 20,
      60_000,
    ),
    configBaseUrl: process.env.BROODS_CONFIG_URL?.trim()
      ? normalizeBaseUrl(process.env.BROODS_CONFIG_URL)
      : undefined,
    coreBaseUrls: normalizedCoreBaseUrls(
      process.env.BROODS_CORE_URLS?.split(",") ?? [],
    ),
    denyInternalPaths: process.env.GATEWAY_DENY_INTERNAL_PATHS !== "false",
    // Proxied HTTP is unmetered unless this is set, and core keeps no per-IP
    // count of its own. Left off by default because channel webhooks arrive on
    // this branch from a provider's egress addresses: one number chosen here
    // would meter a whole retrying fleet as a single caller.
    httpLimiter:
      httpRequestsPerMinute > 0
        ? new RateLimiter(httpRequestsPerMinute, 60_000)
        : undefined,
    limits: gatewayLimitsFromEnv(),
    // Only the service token reads the header, and it never crosses this door.
    proxyOptions: {
      forwardAccountId: process.env.GATEWAY_FORWARD_ACCOUNT_ID === "true",
    },
    terminalTicketSecrets: requireSecretsEnv("TERMINAL_TICKET_SECRET"),
    upgradeLimiter: new RateLimiter(
      Number(process.env.GATEWAY_UPGRADES_PER_MINUTE ?? "") || 120,
      60_000,
    ),
  };
}

if (import.meta.main) {
  const config = gatewayConfigFromEnv();
  const gateway = createGateway(config);
  const server = Bun.serve<GatewayData>({
    port: Number(process.env.PORT ?? "3000"),
    hostname: process.env.BIND_HOST ?? process.env.HOSTNAME ?? "0.0.0.0",
    idleTimeout: config.limits.idleTimeoutSeconds,
    maxRequestBodySize: config.limits.maxRequestBodyBytes,
    fetch: gateway.fetch,
    websocket: gateway.websocket,
  });

  // A rollout sends SIGTERM: stop listening, then close every socket with
  // 1012 (service restart) so clients reconnect to another pod.
  process.once("SIGTERM", (): void => {
    const stopped = server.stop();
    gateway.closeSockets(1012, "gateway restarting");
    void stopped.finally((): never => process.exit(0));
  });

  process.stdout.write(
    `gateway listening on ${server.hostname}:${server.port}\n`,
  );
}

function getNatsConnection(): Promise<NatsConnection> {
  if (!natsConnectionPromise) {
    const natsUrl = process.env.NATS_URL?.trim();
    if (!natsUrl) throw new Error("Gateway requires NATS_URL");

    const pending = connectNats({
      servers: natsUrl,
      token: process.env.NATS_TOKEN?.trim() || undefined,
      maxReconnectAttempts: -1,
    })
      .then((connection) => {
        void connection.closed().then(() => {
          if (natsConnectionPromise === pending) natsConnectionPromise = null;
        });

        return connection;
      })
      .catch((error) => {
        if (natsConnectionPromise === pending) natsConnectionPromise = null;
        throw error;
      });
    natsConnectionPromise = pending;
  }

  return natsConnectionPromise;
}
