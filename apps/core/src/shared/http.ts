import { dns } from "bun";
import { apiErrorBody, type ApiErrorInit } from "@broods/convex/model/apiError";
export { methodNotAllowed } from "@broods/convex/model/httpJson";
import {
  isDeniedAddress,
  type GuardedFetchOptions,
} from "../harness/isolate/runner/pinned-fetch.mjs";

/**
 * The core HTTP contract every handler speaks, plus generic request/response
 * helpers. Handlers take a CoreRequest + RequestContext and return a Web
 * Response; the transport edge (`src/server.ts`) builds the CoreRequest from
 * a real request. Keep route-specific logic out of here.
 */

declare global {
  // Bun 1.4 reads this and @types/bun 1.3.14 does not declare it yet. `false`
  // turns off the 300s socket idle timer for that one request.
  interface BunFetchRequestInit {
    timeout?: number | boolean;
  }
}

// How long `publicHostFetch` reuses a validated address before it resolves
// again. Reuse is safe because the socket is pinned to that address.
const PUBLIC_HOST_TTL_MS = 30_000;
// Tenants pick the hostnames, so the cache is emptied before it can grow without end.
const PUBLIC_HOSTS_MAX = 1_024;

const publicHosts = new Map<string, { address: string; expiresAt: number }>();

/**
 * A transport-neutral inbound request. The server builds one per HTTP request;
 * handlers never see the underlying runtime. Headers are lowercased and the
 * body is already decoded so consumers do not repeat that work.
 */
export interface CoreRequest {
  method: string;
  /** URL pathname as received (no normalization). */
  path: string;
  /** Raw query string without the leading '?'. */
  search: string;
  /** Parsed query parameters. */
  query: URLSearchParams;
  /** Request headers, keys lowercased. */
  headers: Record<string, string>;
  /** Request body decoded to a UTF-8 string. */
  body: string;
  /** Cookie header split into individual `name=value` pairs. */
  cookies: string[];
  /**
   * Client IP from the rightmost X-Forwarded-For hop (the proxy-appended peer),
   * or the socket address. Feeds security controls and abuse attribution,
   * so it must not be the spoofable leftmost XFF entry.
   */
  clientIp: string;
}

/**
 * Per-request execution context. `waitUntil` registers post-response background
 * work (e.g. a channel webhook that acks then processes) that the server drains
 * before shutdown.
 */
export interface RequestContext {
  requestId: string;
  /** Epoch-ms deadline for this request's work budget. */
  deadlineMs: number;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Test seam for any pinned outbound fetch: only `guardedFetch`'s injectable
 * options, never its behavior switches. Production callers pass none, so the
 * socket really opens to the address that was validated and TLS verifies
 * against the system roots.
 */
export type PinnedFetchTransport = Pick<
  GuardedFetchOptions,
  "allowAddresses" | "ca" | "lookup"
>;

export function errorResponse(
  status: number,
  message: string,
  init: ApiErrorInit = {},
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, apiErrorBody(status, message, init), headers);
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

export function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status: status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

export function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function parseJsonBody(request: Pick<CoreRequest, "body">): unknown {
  if (!request.body.trim()) {
    return {};
  }

  try {
    return JSON.parse(request.body);
  } catch (err) {
    throw new Error(
      `Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Validate a user-configured outbound URL: https only, and the hostname must
 * not be a loopback/private/link-local address or an internal-looking name.
 * This is a config-time string check and cannot catch DNS rebinding, so
 * callers performing the fetch should also pass `redirect: "error"`.
 */
export function assertPublicHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use https`);
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error(`${label} must not point to a private or internal address`);
  }

  return url;
}

/**
 * `fetch` for a tenant-configured endpoint (model base URL, MCP server, its
 * OAuth token URL): resolve the hostname, refuse it when any address is
 * private, link-local or a metadata range, then connect to the validated
 * address with the name pinned into SNI and `Host`. That is what stops a public
 * name that later resolves inward, with no rebind window, since
 * `assertPublicHttpsUrl` only sees the hostname string at config time. Bun's
 * `fetch` keeps the streaming Web `Response` the AI SDK needs and `guardedFetch`
 * does not. `redirect: "error"` because a redirect would leave the pinned
 * address.
 */
export async function publicHostFetch(
  input: string | URL | Request,
  init?: BunFetchRequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const hostname = url.hostname;
  const host = url.host;
  if (isPrivateHostname(hostname)) {
    throw new Error(`Refusing to reach private address ${hostname}`);
  }
  let validated = publicHosts.get(hostname);
  if (!validated || validated.expiresAt <= Date.now()) {
    const addresses = await dns.lookup(hostname);
    const [pinned] = addresses;
    if (!pinned) {
      throw new Error(`${hostname} did not resolve`);
    }
    if (addresses.some((entry): boolean => isDeniedAddress(entry.address))) {
      throw new Error(`${hostname} resolves to a private address`);
    }
    validated = {
      address: pinned.family === 6 ? `[${pinned.address}]` : pinned.address,
      expiresAt: Date.now() + PUBLIC_HOST_TTL_MS,
    };
    if (publicHosts.size >= PUBLIC_HOSTS_MAX) {
      publicHosts.clear();
    }
    publicHosts.set(hostname, validated);
  }
  url.hostname = validated.address;
  const request = input instanceof Request ? input : undefined;
  const headers = new Headers(init?.headers ?? request?.headers);
  headers.set("host", host);

  return fetch(url, {
    ...(request
      ? { method: request.method, body: request.body, signal: request.signal }
      : {}),
    ...init,
    headers: headers,
    redirect: "error",
    tls: { serverName: hostname },
  }).catch((error: unknown): never => {
    // An address that will not connect must not be pinned for the rest of the
    // TTL: the next call re-resolves and can reach another record.
    publicHosts.delete(hostname);
    throw error;
  });
}

/** Tests only: forget every validated address. */
export function resetPublicHostsForTests(): void {
  publicHosts.clear();
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (host.includes(":")) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("::ffff:") ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host)
    );
  }

  return false;
}
