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
  type ObservabilityScope,
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
  RateLimiter,
  allowedOriginPatternsFromEnv,
  clientIp,
  gatewayLimitsFromEnv,
  isOriginAllowed,
  json,
  normalizeBaseUrl,
  normalizedCoreBaseUrls,
  websocketToken,
} from "./utils.ts";

type ResolvedObservabilityScope = {
  scope: ObservabilityScope;
  coreBaseUrl: string;
};
type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type GatewayData =
  AgentTestGatewayData | ObservabilityGatewayData | TerminalGatewayData;

let natsConnectionPromise: Promise<NatsConnection> | null = null;
let activeSocketCount = 0;

export async function proxyHttp(
  request: Request,
  coreBaseUrls: string[],
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("upgrade");

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  let response: Response | null = null;
  let unreachable = false;

  for (const coreBaseUrl of coreBaseUrls) {
    // Error boundary: a dead upstream must yield a clean 502 and let the next
    // upstream be tried, not bubble a fetch rejection out of the handler.
    try {
      response = await fetch(`${coreBaseUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });
    } catch {
      unreachable = true;
      continue;
    }
    if (response.status !== 401) return stripEncodingHeaders(response);
  }

  if (response) return stripEncodingHeaders(response);
  if (unreachable)
    return json({ error: "Upstream is unreachable" }, { status: 502 });

  return json({ error: "No core upstream is configured" }, { status: 503 });
}

// Bun's fetch() transparently decompresses a gzip/deflate upstream body but leaves
// the original Content-Encoding/Content-Length on the response. Forwarding those
// stale headers with already-decompressed bytes makes traefik/Cloudflare abort the
// stream, so config-plane list responses arrived empty. Drop them when present.
function stripEncodingHeaders(response: Response): Response {
  if (!response.headers.has("content-encoding")) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function resolveObservabilityScope(
  token: string,
  coreBaseUrls: string[],
  fetchImpl: FetchLike = fetch,
): Promise<ResolvedObservabilityScope | null> {
  for (const coreBaseUrl of coreBaseUrls) {
    try {
      const response = await fetchImpl(
        `${coreBaseUrl}/v1/internal/observability-scope`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) continue;

      return {
        scope: (await response.json()) as ObservabilityScope,
        coreBaseUrl,
      };
    } catch {
      continue;
    }
  }

  return null;
}

export const isCoreHttpPathForTest = isCoreHttpPath;

export function isObservabilityWebSocketPath(pathname: string): boolean {
  return /^\/v1\/[^/]+\/[^/]+\/observability\/ws$/.test(pathname);
}

export function isConfigHttpPath(pathname: string, method = "GET"): boolean {
  const upperMethod = method.toUpperCase();

  if (pathname === "/v1/account")
    return upperMethod === "GET" || upperMethod === "PATCH";
  if (pathname.startsWith("/v1/account/")) return true;
  if (pathname === "/accounts") return upperMethod === "GET";
  if (/^\/accounts\/[^/]+$/.test(pathname))
    return upperMethod === "GET" || upperMethod === "PATCH";
  if (/^\/accounts\/[^/]+\/rotate-secret$/.test(pathname))
    return upperMethod === "POST";
  if (pathname === "/v1/agents")
    return upperMethod === "GET" || upperMethod === "POST";
  if (/^\/v1\/agents\/[^/]+$/.test(pathname)) {
    return (
      upperMethod === "GET" ||
      upperMethod === "PATCH" ||
      upperMethod === "DELETE"
    );
  }
  if (pathname === "/v1/env") return upperMethod === "GET";
  if (/^\/v1\/env\/[^/]+$/.test(pathname)) {
    return upperMethod === "PUT" || upperMethod === "DELETE";
  }

  return (
    /^\/v1\/skills(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/tools(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/hooks(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/workspaces\/[^/]+\/files$/.test(pathname) ||
    /^\/v1\/workspaces(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/sandboxes(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/policies(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/crons(?:\/[^/]+(?:\/runs)?)?$/.test(pathname)
  );
}

if (import.meta.main) {
  const coreBaseUrls = normalizedCoreBaseUrls(
    process.env.BROODS_CORE_URLS?.split(",") ?? [],
  );
  const configBaseUrl = process.env.BROODS_CONFIG_URL?.trim()
    ? normalizeBaseUrl(process.env.BROODS_CONFIG_URL)
    : undefined;
  const limits = gatewayLimitsFromEnv();
  const allowedOrigins = allowedOriginPatternsFromEnv();
  // Per-IP guards: upgrade attempts bound connection churn, auth failures bound
  // token brute force (checked before the core auth roundtrip).
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
      // Error boundary: no handler failure may leak a stack trace or kill the
      // request without a JSON body.
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
      // Health is public and read by browsers (the dashboard's agent-health
      // indicator polls this from its own origin), so allow any origin here.
      return json(
        {
          status: "ok",
          activeWebSockets: activeSocketCount,
          maxWebSockets: limits.maxConnections,
        },
        { headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    if (isWebSocketRequest(request)) {
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

      if (isObservabilityWebSocketPath(url.pathname)) {
        if (activeSocketCount >= limits.maxConnections) {
          return json({ error: "Gateway is at capacity" }, { status: 503 });
        }

        const token = websocketToken(request, url);
        if (!token)
          return json({ error: "Missing WebSocket token" }, { status: 401 });

        const obsMatch = url.pathname.match(
          /^\/v1\/([^/]+)\/([^/]+)\/observability\/ws$/,
        );
        if (!obsMatch)
          return json(
            { error: "Invalid observability WebSocket path" },
            { status: 400 },
          );

        const resolved = await resolveObservabilityScope(token, coreBaseUrls);
        if (!resolved) {
          authFailureLimiter.allow(ip);
          return json({ error: "Invalid WebSocket token" }, { status: 401 });
        }
        if (
          resolved.scope.projectSlug !== decodeURIComponent(obsMatch[1]) ||
          resolved.scope.environmentSlug !== decodeURIComponent(obsMatch[2])
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
            project: obsMatch[1],
            env: obsMatch[2],
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

    if (!isCoreHttpPath(url.pathname))
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
      // Long-lived relay: never give up on the broker (nats.js defaults to 10
      // attempts and then closes the connection for good).
      maxReconnectAttempts: -1,
    })
      .then((connection) => {
        // If the client still ends up closed (auth revoked, unrecoverable
        // error), drop the cache so the next subscriber dials fresh instead of
        // reusing a dead connection forever.
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

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function isWebSocketPath(pathname: string): boolean {
  return (
    /^\/v1\/agents\/[^/]+\/ws$/.test(pathname) ||
    /^\/v1\/[^/]+\/agents\/[^/]+\/[^/]+\/ws$/.test(pathname)
  );
}

function isCoreHttpPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/async" ||
    pathname.startsWith("/status/") ||
    pathname === "/accounts" ||
    pathname.startsWith("/accounts/") ||
    pathname.startsWith("/webhooks/") ||
    pathname.startsWith("/async-tools/") ||
    pathname.startsWith("/sandbox-jobs/") ||
    pathname === "/v1" ||
    pathname.startsWith("/v1/")
  );
}
