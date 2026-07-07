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
  bearerToken,
  gatewayLimitsFromEnv,
  json,
  normalizeBaseUrl,
  normalizedCoreBaseUrls,
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

  for (const coreBaseUrl of coreBaseUrls) {
    response = await fetch(`${coreBaseUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
    if (response.status !== 401) return stripEncodingHeaders(response);
  }

  return response
    ? stripEncodingHeaders(response)
    : json({ error: "No core upstream is configured" }, { status: 503 });
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

  return (
    /^\/v1\/skills(?:\/[^/]+)?$/.test(pathname) ||
    /^\/v1\/tools(?:\/[^/]+)?$/.test(pathname) ||
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

  const server = Bun.serve<GatewayData>({
    port: Number(process.env.PORT ?? "3000"),
    hostname: process.env.BIND_HOST ?? process.env.HOSTNAME ?? "0.0.0.0",
    idleTimeout: limits.idleTimeoutSeconds,
    async fetch(request, server) {
      const url = new URL(request.url);

      if (
        (url.pathname === "/" || url.pathname === "/healthz") &&
        request.method === "GET"
      ) {
        return json({
          status: "ok",
          activeWebSockets: activeSocketCount,
          maxWebSockets: limits.maxConnections,
        });
      }

      if (isWebSocketRequest(request)) {
        if (url.pathname === TERMINAL_WEBSOCKET_PATH) {
          if (activeSocketCount >= limits.maxConnections) {
            return json({ error: "Gateway is at capacity" }, { status: 503 });
          }

          const token = url.searchParams.get("token") ?? "";
          const ticket = openTerminalTicketWithSecrets(
            token,
            terminalServiceSecretsFromEnv(),
          );
          if (!ticket)
            return json(
              { error: "Invalid or expired terminal ticket" },
              { status: 401 },
            );

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

          const token =
            bearerToken(request.headers.get("authorization")) ??
            url.searchParams.get("token") ??
            "";
          if (!token.trim())
            return json({ error: "Missing WebSocket token" }, { status: 401 });

          const obsMatch = url.pathname.match(
            /^\/v1\/([^/]+)\/([^/]+)\/observability\/ws$/,
          );
          if (!obsMatch)
            return json(
              { error: "Invalid observability WebSocket path" },
              { status: 400 },
            );

          const resolved = await resolveObservabilityScope(
            token.trim(),
            coreBaseUrls,
          );
          if (!resolved)
            return json({ error: "Invalid WebSocket token" }, { status: 401 });
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
              token: token.trim(),
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

          const token =
            bearerToken(request.headers.get("authorization")) ??
            url.searchParams.get("token") ??
            "";
          if (!token.trim())
            return json({ error: "Missing WebSocket token" }, { status: 401 });

          const resolved = await resolveObservabilityScope(
            token.trim(),
            coreBaseUrls,
          );
          if (!resolved)
            return json({ error: "Invalid WebSocket token" }, { status: 401 });

          const upgraded = server.upgrade(request, {
            data: {
              kind: "agent-test",
              corePath: url.pathname.slice(0, -"/ws".length),
              token: token.trim(),
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
    },
    websocket: {
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
    },
  });

  process.stdout.write(
    `gateway listening on ${server.hostname}:${server.port}\n`,
  );
}

function getNatsConnection(): Promise<NatsConnection> {
  if (!natsConnectionPromise) {
    const natsUrl = process.env.NATS_URL?.trim();
    if (!natsUrl) throw new Error("Gateway requires NATS_URL");

    natsConnectionPromise = connectNats({
      servers: natsUrl,
      token: process.env.NATS_TOKEN?.trim() || undefined,
    }).catch((error) => {
      natsConnectionPromise = null;
      throw error;
    });
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
