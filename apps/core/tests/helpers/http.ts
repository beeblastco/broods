import { dns } from "bun";
import { spyOn } from "bun:test";
import {
  resetPublicHostsForTests,
  type CoreRequest,
  type RequestContext,
} from "../../src/shared/http.ts";

export function coreRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): CoreRequest {
  const url = new URL(`https://example.test${path}`);
  const lowerHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowerHeaders[key.toLowerCase()] = value;
  }

  return {
    method: method,
    path: url.pathname,
    search: url.search.startsWith("?") ? url.search.slice(1) : url.search,
    query: url.searchParams,
    headers: lowerHeaders,
    body:
      body === undefined
        ? ""
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
    cookies:
      lowerHeaders.cookie
        ?.split(";")
        .map((cookie) => cookie.trim())
        .filter(Boolean) ?? [],
    clientIp:
      lowerHeaders["x-forwarded-for"]
        ?.split(",")
        .map((ip) => ip.trim())
        .filter(Boolean)
        .pop() ?? "127.0.0.1",
  };
}

export function testContext(): RequestContext {
  return {
    requestId: "request-id",
    deadlineMs: Date.now() + 60_000,
    waitUntil: function () {},
  };
}

export async function responseJson(response: Response): Promise<any> {
  return await response.json();
}

/**
 * Resolve every name `publicHostFetch` looks up to `address`, so a test can
 * reach a tenant host with no DNS. The returned function undoes it.
 */
export function stubPublicDns(address = "93.184.216.34"): () => void {
  const lookup = spyOn(dns, "lookup").mockResolvedValue([
    { address: address, family: 4, ttl: 30 },
  ]);

  return (): void => {
    lookup.mockRestore();
    resetPublicHostsForTests();
  };
}
