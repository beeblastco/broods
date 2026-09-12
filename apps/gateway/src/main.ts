import {
  connectNats,
  type NatsConnection,
} from "../../core/src/shared/nats.ts";
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
  terminalServiceSecretsFromEnv,
  type TerminalGatewayData,
} from "./terminal.ts";
import {
  isConfigHttpPath,
  isCoreHttpRoute,
  matchAgentWebSocketPath,
  matchObservabilityWebSocketPath,
} from "./routes.ts";
import { RateLimiter } from "./rate-limiter.ts";
import {
  proxyHttp,
  resolveObservabilityScope,
  type ProxyOptions,
} from "./upstream.ts";
import {
  allowedOriginPatternsFromEnv,
  clientIp,
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
  withRequestId,
  type GatewayLimits,
} from "./utils.ts";

export type GatewayData =
  | AgentTestGatewayData
  | ObservabilityGatewayData
  | TerminalGatewayData;

let natsConnectionPromise: Promise<NatsConnection> | null = null;

/** Everything the router reads that the process environment decides. */
export interface GatewayConfig {
  allowedOrigins: string[];
  authFailureLimiter: RateLimiter;
  configBaseUrl: string | undefined;
  coreBaseUrls: string[];
  httpLimiter: RateLimiter | undefined;
  limits: GatewayLimits;
  proxyOptions: ProxyOptions;
  upgradeLimiter: RateLimiter;
}

/** The two halves `Bun.serve` needs, built over one resolved config. */
export interface GatewayRuntime {
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
 * rate limit, auth-failure rate limit, then the per-path token and scope checks.
 * The open socket count is per gateway, so two of them in one test process do
 * not share a capacity ceiling.
 */
export function createGateway(config: GatewayConfig): GatewayRuntime {
  let activeSocketCount = 0;

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
          activeWebSockets: activeSocketCount,
          maxWebSockets: config.limits.maxConnections,
        },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
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
          rateLimitHeaders(config.upgradeLimiter, ip),
        );
      }
      if (config.authFailureLimiter.blocked(ip)) {
        return jsonError(
          429,
          "Too many failed authentication attempts",
          {},
          rateLimitHeaders(config.authFailureLimiter, ip),
        );
      }

      if (url.pathname === TERMINAL_WEBSOCKET_PATH) {
        if (activeSocketCount >= config.limits.maxConnections) {
          return jsonError(503, "Gateway is at capacity");
        }

        const token = websocketToken(request, url);
        const ticket = openTerminalTicketWithSecrets(
          token,
          terminalServiceSecretsFromEnv(),
        );
        if (!ticket) {
          config.authFailureLimiter.allow(ip);

          return jsonError(401, "Invalid or expired terminal ticket", {
            code: "invalid_terminal_ticket",
          });
        }

        const upgraded = server.upgrade(request, {
          headers: websocketUpgradeHeaders(request),
          data: {
            kind: "terminal",
            ticket: ticket,
          } satisfies TerminalGatewayData,
        });

        return upgraded
          ? undefined
          : jsonError(400, "WebSocket upgrade failed");
      }

      const observabilityPath = matchObservabilityWebSocketPath(url.pathname);
      if (observabilityPath) {
        if (activeSocketCount >= config.limits.maxConnections) {
          return jsonError(503, "Gateway is at capacity");
        }

        warnDeprecatedQueryToken(request, url);
        const token = websocketToken(request, url);
        if (!token) return jsonError(401, "Missing WebSocket token");

        const resolved = await resolveObservabilityScope(
          token,
          config.coreBaseUrls,
        );
        if (!resolved) {
          config.authFailureLimiter.allow(ip);

          return jsonError(401, "Invalid WebSocket token");
        }
        if (
          resolved.scope.projectSlug !==
            decodeURIComponent(observabilityPath[1]) ||
          resolved.scope.stageSlug !== decodeURIComponent(observabilityPath[2])
        ) {
          return jsonError(
            403,
            "WebSocket scope does not match the requested project/stage",
            { code: "scope_mismatch" },
          );
        }

        const upgraded = server.upgrade(request, {
          headers: websocketUpgradeHeaders(request),
          data: {
            kind: "observability",
            project: observabilityPath[1],
            stage: observabilityPath[2],
            token: token,
            scope: resolved.scope,
          } satisfies ObservabilityGatewayData,
        });

        return upgraded
          ? undefined
          : jsonError(400, "WebSocket upgrade failed");
      }

      const agentWebSocketPath = matchAgentWebSocketPath(url.pathname);
      if (agentWebSocketPath) {
        if (activeSocketCount >= config.limits.maxConnections) {
          return jsonError(503, "Gateway is at capacity");
        }

        warnDeprecatedQueryToken(request, url);
        const token = websocketToken(request, url);
        if (!token) return jsonError(401, "Missing WebSocket token");

        const resolved = await resolveObservabilityScope(
          token,
          config.coreBaseUrls,
        );
        if (!resolved) {
          config.authFailureLimiter.allow(ip);

          return jsonError(401, "Invalid WebSocket token");
        }
        // Bind the socket to the key's own endpoint scope: attach never posts
        // through the core run path, so the door check must happen here.
        if (
          !resolved.scope.endpointIds.includes(agentWebSocketPath.endpointId) ||
          (agentWebSocketPath.projectSlug !== undefined &&
            resolved.scope.projectSlug !== agentWebSocketPath.projectSlug) ||
          (agentWebSocketPath.stageSlug !== undefined &&
            resolved.scope.stageSlug !== agentWebSocketPath.stageSlug)
        ) {
          return jsonError(
            403,
            "WebSocket scope does not match the requested endpoint",
            { code: "scope_mismatch" },
          );
        }

        const upgraded = server.upgrade(request, {
          headers: websocketUpgradeHeaders(request),
          data: {
            kind: "agent-test",
            corePath: url.pathname.slice(0, -"/ws".length),
            token: token,
            coreBaseUrl: resolved.coreBaseUrl,
            accountId: resolved.scope.accountId,
          } satisfies AgentTestGatewayData,
        });

        return upgraded
          ? undefined
          : jsonError(400, "WebSocket upgrade failed");
      }
    }

    const requestIp = clientIp(request, server.requestIP(request)?.address);
    if (config.httpLimiter && !config.httpLimiter.allow(requestIp)) {
      return jsonError(
        429,
        "Too many requests",
        {},
        rateLimitHeaders(config.httpLimiter, requestIp),
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

    if (!isCoreHttpRoute(url.pathname)) return jsonError(404, "Not found");

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
      return response ? withRequestId(response, requestId) : response;
    } catch (error) {
      console.error("gateway request failed:", {
        requestId: requestId,
        error: error,
      });

      return withRequestId(jsonError(500, "Internal gateway error"), requestId);
    }
  }

  const websocket: Bun.WebSocketHandler<GatewayData> = {
    maxPayloadLength: config.limits.maxPayloadBytes,
    backpressureLimit: config.limits.backpressureBytes,
    closeOnBackpressureLimit: true,
    idleTimeout: config.limits.idleTimeoutSeconds,
    open: function (socket): void {
      activeSocketCount += 1;
      if (socket.data.kind === "observability")
        openObservabilitySocket(
          socket as Bun.ServerWebSocket<ObservabilityGatewayData>,
        );
      if (socket.data.kind === "terminal")
        openTerminalUpstream(
          socket as Bun.ServerWebSocket<TerminalGatewayData>,
        );
    },
    message: async function (socket, rawMessage): Promise<void> {
      if (socket.data.kind === "terminal") {
        relayTerminalInput(
          socket as Bun.ServerWebSocket<TerminalGatewayData>,
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
      activeSocketCount = Math.max(0, activeSocketCount - 1);
      if (socket.data.kind === "terminal") {
        cleanupTerminalSocket(
          socket as Bun.ServerWebSocket<TerminalGatewayData>,
        );

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
    // Proxied HTTP is unmetered unless this is set, and core keeps no per-IP
    // count of its own. Left off by default because channel webhooks arrive on
    // this branch from a provider's egress addresses: one number chosen here
    // would meter a whole retrying fleet as a single caller.
    httpLimiter:
      httpRequestsPerMinute > 0
        ? new RateLimiter(httpRequestsPerMinute, 60_000)
        : undefined,
    limits: gatewayLimitsFromEnv(),
    // Defaults on because Convex still reaches core through this gateway; flip
    // to "false" once BROODS_ACCOUNT_MANAGE_URL points at core in-cluster.
    proxyOptions: {
      forwardAccountId: process.env.GATEWAY_FORWARD_ACCOUNT_ID !== "false",
    },
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
    fetch: gateway.fetch,
    websocket: gateway.websocket,
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
