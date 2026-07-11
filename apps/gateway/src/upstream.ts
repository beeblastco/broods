import type { ObservabilityScope } from "./observability.ts";
import { json } from "./utils.ts";

type ResolvedObservabilityScope = {
  scope: ObservabilityScope;
  coreBaseUrl: string;
};

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function proxyHttp(
  request: Request,
  coreBaseUrls: string[],
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  let response: Response | null = null;
  let unreachable = false;

  headers.delete("host");
  headers.delete("connection");
  headers.delete("upgrade");

  for (const coreBaseUrl of coreBaseUrls) {
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

    if (response.status !== 401) return responseWithoutEncoding(response);
  }

  if (response) return responseWithoutEncoding(response);
  if (unreachable)
    return json({ error: "Upstream is unreachable" }, { status: 502 });

  return json({ error: "No core upstream is configured" }, { status: 503 });
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

function responseWithoutEncoding(response: Response): Response {
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
