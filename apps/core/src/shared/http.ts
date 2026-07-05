/**
 * The core HTTP contract every handler speaks, plus generic request/response
 * helpers. Handlers take a CoreRequest + RequestContext and return a Web
 * Response; the transport edge (functions/server/) builds the CoreRequest from
 * a real request. Keep route-specific logic out of here.
 */

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
 * before shutdown — the same role the Lambda runtime's response-tail once served.
 */
export interface RequestContext {
  requestId: string;
  /** Epoch-ms deadline for this request's work budget. */
  deadlineMs: number;
  waitUntil(promise: Promise<unknown>): void;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
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
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

export function errorResponse(
  status: number,
  error: string,
  details: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { error, ...details }, headers);
}

export function parseJsonBody(request: Pick<CoreRequest, "body">): unknown {
  if (!request.body.trim()) {
    return {};
  }

  try {
    return JSON.parse(request.body);
  } catch (err) {
    throw new Error(`Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Validate a user-configured outbound URL: https only, and the hostname must
 * not be a loopback/private/link-local address or an internal-looking name.
 * This is a config-time string check — it cannot catch DNS rebinding — so
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

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }

  if (host.includes(":")) {
    return host === "::" || host === "::1" || host.startsWith("::ffff:") ||
      /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }

  return false;
}
