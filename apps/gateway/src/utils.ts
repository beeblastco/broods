export type GatewayLimits = {
  maxConnections: number;
  maxPayloadBytes: number;
  backpressureBytes: number;
  idleTimeoutSeconds: number;
  runStartTimeoutMs: number;
};

export const decoder = new TextDecoder();

const maxBunIdleTimeoutSeconds = 255;

export function json(
  payload: Record<string, unknown>,
  init: ResponseInit = {},
): Response {
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
  if (!trimmed) throw new Error("Gateway requires BROODS_CORE_URLS");

  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
}

export function normalizedCoreBaseUrls(values: string[]): string[] {
  const urls = [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map(normalizeBaseUrl),
    ),
  ];
  if (urls.length === 0) throw new Error("Gateway requires BROODS_CORE_URLS");

  return urls;
}

export function bearerToken(value: string | null): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);

  return match?.[1]?.trim() || null;
}

// Header-first WebSocket auth: browsers cannot set Authorization on upgrade
// requests, so the query param stays as their fallback. Non-browser clients
// (SDK, CLI) should send the header and never put tokens in URLs.
export function websocketToken(request: Request, url: URL): string {
  return (
    bearerToken(request.headers.get("authorization")) ??
    url.searchParams.get("token") ??
    ""
  ).trim();
}

// Browser-origin allow-list for WebSocket upgrades. Patterns match the origin
// hostname: exact ("dashboard.broods.app", "localhost") or wildcard suffix
// ("*.broods.app"). Requests without an Origin header (SDK/CLI) always pass.
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

  return ["broods.app", "*.broods.app", "localhost", "127.0.0.1"];
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

// Fixed-window per-key counter for upgrade attempts and auth failures. In-memory
// and per-pod on purpose: the gateway is stateless and scales with replicas, so
// each pod bounding its own share is enough to stop brute force and floods.
export class RateLimiter {
  #limit: number;
  #windowMs: number;
  #windows = new Map<string, { start: number; count: number }>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const window = this.#windows.get(key);
    if (!window || now - window.start >= this.#windowMs) {
      if (this.#windows.size > 10_000) this.#prune(now);
      this.#windows.set(key, { start: now, count: 1 });
      return true;
    }

    window.count += 1;
    return window.count <= this.#limit;
  }

  // Read-only check: is this key already over the limit in the current window?
  // Used to reject before doing expensive work without counting the probe itself.
  blocked(key: string): boolean {
    const window = this.#windows.get(key);
    if (!window || Date.now() - window.start >= this.#windowMs) return false;

    return window.count >= this.#limit;
  }

  #prune(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}

export function clientIp(
  request: Request,
  fallback: string | undefined,
): string {
  const forwarded = request.headers.get("x-forwarded-for");

  return (
    request.headers.get("x-real-ip")?.trim() ||
    forwarded?.split(",")[0]?.trim() ||
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
  const results: PromiseSettledResult<R>[] = new Array(items.length);
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
        results[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return results;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
