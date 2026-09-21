import { VIA_GATEWAY_HEADER } from "../../../packages/convex/model/serviceBridge.ts";
import type { ObservabilityScope } from "./observability.ts";
import { jsonError } from "./utils.ts";

type ResolvedObservabilityScope = {
  scope: ObservabilityScope;
  coreBaseUrl: string;
};

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
  headers.delete("host");
  headers.delete("connection");
  headers.delete("upgrade");
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
      });
    } catch {
      unreachable = true;
      continue;
    }

    if (response.status !== 401) return responseWithoutEncoding(response);
  }

  if (response) return responseWithoutEncoding(response);
  if (unreachable) return jsonError(502, "Upstream is unreachable");

  return jsonError(503, "No core upstream is configured");
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
            [VIA_GATEWAY_HEADER]: "1",
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) continue;

      return {
        scope: (await response.json()) as ObservabilityScope,
        coreBaseUrl: coreBaseUrl,
      };
    } catch {
      continue;
    }
  }

  return null;
}

function responseWithoutEncoding(response: Response): Response {
  if (!response.headers.has("content-encoding")) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers,
  });
}
