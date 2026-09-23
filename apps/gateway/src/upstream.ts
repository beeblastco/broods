import { VIA_GATEWAY_HEADER } from "../../../packages/convex/model/serviceBridge.ts";
import type { ObservabilityScope } from "./observability.ts";
import { jsonError } from "./utils.ts";

// Headers that describe the client's hop, not the request, so never forwarded.
const HOP_BY_HOP_HEADERS = [
  "connection",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
// Safe to resend to the next core after a network error. A POST may already
// have run on the first one, so it is never replayed.
const RETRYABLE_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PUT"]);

/**
 * A socket credential checked against core. `invalid` means every core refused
 * the token; `unavailable` means one could not answer, which is an outage and
 * not the caller's fault.
 */
export type SocketScope =
  | { kind: "resolved"; scope: ObservabilityScope; coreBaseUrl: string }
  | { kind: "invalid" }
  | { kind: "unavailable" };

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ProxyOptions = {
  /** Request id forwarded to core so both hops log the same one. */
  requestId?: string;
  /** Forward a client `X-Account-Id`. Off unless `GATEWAY_FORWARD_ACCOUNT_ID=true`. */
  forwardAccountId?: boolean;
};

/**
 * Forwards one request to the first core that accepts it. The client's
 * `Accept-Encoding` goes along and the body comes back undecoded, so a
 * compressed answer reaches the client as core sent it.
 */
export async function proxyHttp(
  request: Request,
  coreBaseUrls: string[],
  options: ProxyOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  let response: Response | null = null;
  let unreachable = false;

  if (options.requestId) headers.set("x-request-id", options.requestId);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  if (options.forwardAccountId !== true) headers.delete("x-account-id");
  // `set`, not `append`: a client copy must never survive.
  headers.set(VIA_GATEWAY_HEADER, "1");

  for (const coreBaseUrl of coreBaseUrls) {
    try {
      response = await fetch(`${coreBaseUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers: headers,
        body: body,
        redirect: "manual",
        signal: request.signal,
        decompress: false,
      });
    } catch {
      unreachable = true;
      if (!RETRYABLE_METHODS.has(request.method)) break;
      continue;
    }

    if (response.status !== 401) return response;
  }

  if (response) return response;
  if (unreachable) return jsonError(502, "Upstream is unreachable");

  return jsonError(503, "No core upstream is configured");
}

/** Resolves the scope a socket token grants, from the first core that knows it. */
export async function resolveSocketScope(
  token: string,
  coreBaseUrls: string[],
  fetchImpl: FetchLike = fetch,
): Promise<SocketScope> {
  let unavailable = false;
  for (const coreBaseUrl of coreBaseUrls) {
    try {
      const response = await fetchImpl(
        `${coreBaseUrl}/v1/internal/observability-scope`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            [VIA_GATEWAY_HEADER]: "1",
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (response.ok) {
        return {
          kind: "resolved",
          scope: (await response.json()) as ObservabilityScope,
          coreBaseUrl: coreBaseUrl,
        };
      }
      if (response.status !== 401 && response.status !== 403)
        unavailable = true;
    } catch {
      unavailable = true;
    }
  }

  return unavailable ? { kind: "unavailable" } : { kind: "invalid" };
}
