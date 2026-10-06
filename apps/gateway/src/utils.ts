import type { ApiError } from "../../../packages/convex/model/apiError.ts";
import { DEFAULT_ORIGINS } from "../../edge/src/origins.ts";

export {
  resolveRequestId,
  withRequestId,
} from "../../../packages/convex/model/requestId.ts";
export {
  jsonError,
  rateLimitHeaders,
} from "../../../packages/convex/model/httpJson.ts";

export type GatewayLimits = {
  maxConnections: number;
  maxPayloadBytes: number;
  backpressureBytes: number;
  idleTimeoutSeconds: number;
  runStartTimeoutMs: number;
};

export const decoder = new TextDecoder();
/** Subprotocol the gateway selects so a token-bearing handshake completes. */
const WEBSOCKET_SUBPROTOCOL = "broods.v1";
/** `Sec-WebSocket-Protocol` entry prefix that carries the credential. */
const WEBSOCKET_TOKEN_SUBPROTOCOL_PREFIX = "broods.token.";
const maxBunIdleTimeoutSeconds = 255;

/** The message from either shape core puts in `error`: envelope or plain text. */
export function errorText(
  error: string | ApiError | undefined,
): string | undefined {
  return typeof error === "string" ? error : error?.message;
}

export function json(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Gateway requires BROODS_CORE_URL");

  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
}

/**
 * WebSocket credential: the Authorization header, else the token carried as a
 * `broods.token.<token>` entry in `Sec-WebSocket-Protocol` (browsers cannot
 * set headers on an upgrade). A `?token=` query parameter is ignored, with a
 * warning: query strings end up in access logs.
 */
export function websocketToken(request: Request): string {
  const token = (
    bearerToken(request.headers.get("authorization")) ??
    subprotocolToken(request) ??
    ""
  ).trim();
  const url = new URL(request.url);
  if (!token && url.searchParams.has("token")) {
    console.warn(
      `ignored WebSocket credential in ?token= on ${url.pathname}; send it as Sec-WebSocket-Protocol "broods.token.<key>"`,
    );
  }

  return token;
}

/**
 * Response headers for an upgrade. A client that offered subprotocols fails
 * the handshake unless the server selects one, so `broods.v1` is echoed back;
 * the token entry is never echoed. Undefined, never `{}`, when `broods.v1`
 * was not offered: Bun's `server.upgrade` throws on an empty headers object.
 */
export function websocketUpgradeHeaders(
  request: Request,
): HeadersInit | undefined {
  return offeredSubprotocols(request).includes(WEBSOCKET_SUBPROTOCOL)
    ? { "Sec-WebSocket-Protocol": WEBSOCKET_SUBPROTOCOL }
    : undefined;
}

export function allowedOriginPatternsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.GATEWAY_ALLOWED_ORIGINS?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return [...DEFAULT_ORIGINS];
}

export function isOriginAllowed(
  origin: string | null,
  patterns: string[],
): boolean {
  if (!origin || !origin.trim()) return true;
  if (patterns.includes("*")) return true;

  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    if (normalized.startsWith("*."))
      return hostname.endsWith(normalized.slice(1));

    return hostname === normalized;
  });
}

/**
 * Rate-limit key for a request. Trusts the rightmost forwarded address added by
 * the ingress, never client input: an inbound `X-Real-Ip`, or a hop the caller
 * prepended to `X-Forwarded-For`, would otherwise let one attacker mint a fresh
 * limiter bucket per request. Matches `apps/core/src/server.ts`.
 */
export function clientIp(
  request: Request,
  fallback: string | undefined,
): string {
  const forwarded = request.headers.get("x-forwarded-for");

  return (
    forwarded
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .pop() ||
    fallback ||
    "unknown"
  );
}

export function gatewayLimitsFromEnv(
  env: Record<string, string | undefined> = process.env,
): GatewayLimits {
  return {
    maxConnections: positiveInt(env.GATEWAY_MAX_CONNECTIONS, 10_000),
    maxPayloadBytes: positiveInt(env.GATEWAY_MAX_PAYLOAD_BYTES, 1024 * 1024),
    backpressureBytes: positiveInt(env.GATEWAY_BACKPRESSURE_BYTES, 1024 * 1024),
    idleTimeoutSeconds: Math.min(
      positiveInt(env.GATEWAY_IDLE_TIMEOUT_SECONDS, maxBunIdleTimeoutSeconds),
      maxBunIdleTimeoutSeconds,
    ),
    runStartTimeoutMs: positiveInt(env.GATEWAY_RUN_START_TIMEOUT_MS, 15_000),
  };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = Array.from<PromiseSettledResult<R>>({
    length: items.length,
  });
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await mapper(items[index]),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason: reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return results;
}

function bearerToken(value: string | null): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
}

function offeredSubprotocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function subprotocolToken(request: Request): string | null {
  const entry = offeredSubprotocols(request).find((candidate) =>
    candidate.startsWith(WEBSOCKET_TOKEN_SUBPROTOCOL_PREFIX),
  );

  return entry ? entry.slice(WEBSOCKET_TOKEN_SUBPROTOCOL_PREFIX.length) : null;
}
