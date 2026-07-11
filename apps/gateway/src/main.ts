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
  isWebSocketPath,
  matchObservabilityWebSocketPath,
} from "./routes.ts";
import { RateLimiter } from "./rate-limiter.ts";
import { proxyHttp, resolveObservabilityScope } from "./upstream.ts";
import {
  allowedOriginPatternsFromEnv,
  clientIp,
  gatewayLimitsFromEnv,
  isOriginAllowed,
  json,
  normalizeBaseUrl,
  normalizedCoreBaseUrls,
  websocketToken,
} from "./utils.ts";

type GatewayData =
  AgentTestGatewayData | ObservabilityGatewayData | TerminalGatewayData;

let natsConnectionPromise: Promise<NatsConnection> | null = null;
let activeSocketCount = 0;

if (import.meta.main) {
  const coreBaseUrls = normalizedCoreBaseUrls(
    process.env.BROODS_CORE_URLS?.split(",") ?? [],
  );
  const configBaseUrl = process.env.BROODS_CONFIG_URL?.trim()
    ? normalizeBaseUrl(process.env.BROODS_CONFIG_URL)
    : undefined;
  const limits = gatewayLimitsFromEnv();
  const allowedOrigins = allowedOriginPatternsFromEnv();
  const upgradeLimiter = new RateLimiter(
    Number(process.env.GATEWAY_UPGRADES_PER_MINUTE ?? "") || 120,
    60_000,
  );
  const authFailureLimiter = new RateLimiter(
    Number(process.env.GATEWAY_AUTH_FAILURES_PER_MINUTE ?? "") || 20,
    60_000,
  );

  const server = Bun.serve<GatewayData>({
    port: Number(process.env.PORT ?? "3000"),
    hostname: process.env.BIND_HOST ?? process.env.HOSTNAME ?? "0.0.0.0",
    idleTimeout: limits.idleTimeoutSeconds,
    async fetch(request, server) {
      try {
        return await route(request, server);
      } catch (error) {
        console.error("gateway request failed:", error);
        return json({ error: "Internal gateway error" }, { status: 500 });
      }
    },
    websocket: websocketHandlers(),
  });

  async function route(
    request: Request,
    server: Bun.Server<GatewayData>,
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
          maxWebSockets: limits.maxConnections,
        },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (!isOriginAllowed(request.headers.get("origin"), allowedOrigins)) {
        return json({ error: "Origin is not allowed" }, { status: 403 });
      }
      const ip = clientIp(request, server.requestIP(request)?.address);
      if (!upgradeLimiter.allow(ip)) {
        return json({ error: "Too many connection attempts" }, { status: 429 });
      }
      if (authFailureLimiter.blocked(ip)) {
        return json(
          { error: "Too many failed authentication attempts" },
          { status: 429 },
        );
      }

      if (url.pathname === TERMINAL_WEBSOCKET_PATH) {
        if (activeSocketCount >= limits.maxConnections) {
          return json({ error: "Gateway is at capacity" }, { status: 503 });
        }

        const token = websocketToken(request, url);
        const ticket = openTerminalTicketWithSecrets(
          token,
          terminalServiceSecretsFromEnv(),
        );
        if (!ticket) {
          authFailureLimiter.allow(ip);
          return json(
            { error: "Invalid or expired terminal ticket" },
            { status: 401 },
          );
        }

        const upgraded = server.upgrade(request, {
          data: { kind: "terminal", ticket } satisfies TerminalGatewayData,
        });

        return upgraded
          ? undefined
          : json({ error: "WebSocket upgrade failed" }, { status: 400 });
      }

      const observabilityPath = matchObservabilityWebSocketPath(url.pathname);
      if (observabilityPath) {
        if (activeSocketCount >= limits.maxConnections) {
          return json({ error: "Gateway is at capacity" }, { status: 503 });
        }

        const token = websocketToken(request, url);
        if (!token)
          return json({ error: "Missing WebSocket token" }, { status: 401 });

        const resolved = await resolveObservabilityScope(token, coreBaseUrls);
        if (!resolved) {
          authFailureLimiter.allow(ip);
          return json({ error: "Invalid WebSocket token" }, { status: 401 });
        }
        if (
          resolved.scope.projectSlug !==
            decodeURIComponent(observabilityPath[1]) ||
          resolved.scope.environmentSlug !==
            decodeURIComponent(observabilityPath[2])
        ) {
          return json(
            {
              error:
                "WebSocket scope does not match the requested project/environment",
            },
            { status: 403 },
          );
        }

        const upgraded = server.upgrade(request, {
          data: {
            kind: "observability",
            project: observabilityPath[1],
            env: observabilityPath[2],
            token,
            scope: resolved.scope,
          } satisfies ObservabilityGatewayData,
        });

        return upgraded
          ? undefined
          : json({ error: "WebSocket upgrade failed" }, { status: 400 });
      }

      if (isWebSocketPath(url.pathname)) {
        if (activeSocketCount >= limits.maxConnections) {
          return json({ error: "Gateway is at capacity" }, { status: 503 });
        }

        const token = websocketToken(request, url);
        if (!token)
          return json({ error: "Missing WebSocket token" }, { status: 401 });

        const resolved = await resolveObservabilityScope(token, coreBaseUrls);
        if (!resolved) {
          authFailureLimiter.allow(ip);
          return json({ error: "Invalid WebSocket token" }, { status: 401 });
        }

        const upgraded = server.upgrade(request, {
          data: {
            kind: "agent-test",
            corePath: url.pathname.slice(0, -"/ws".length),
            token,
            coreBaseUrl: resolved.coreBaseUrl,
          } satisfies AgentTestGatewayData,
        });

        return upgraded
          ? undefined
          : json({ error: "WebSocket upgrade failed" }, { status: 400 });
      }
    }

    if (isConfigHttpPath(url.pathname, request.method)) {
      if (!configBaseUrl)
        return json(
          { error: "Config plane is not configured (BROODS_CONFIG_URL)" },
          { status: 503 },
        );

      return proxyHttp(request, [configBaseUrl]);
    }

    if (!isCoreHttpRoute(url.pathname))
      return json({ error: "Not found" }, { status: 404 });

    return proxyHttp(request, coreBaseUrls);
  }

  function websocketHandlers(): Bun.WebSocketHandler<GatewayData> {
    return {
      maxPayloadLength: limits.maxPayloadBytes,
      backpressureLimit: limits.backpressureBytes,
      closeOnBackpressureLimit: true,
      idleTimeout: limits.idleTimeoutSeconds,
      open(socket) {
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
      async message(socket, rawMessage) {
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
          limits,
          getNatsConnection,
        );
      },
      close(socket) {
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
  }

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
