import { dns } from "bun";
import { spyOn } from "bun:test";
import {
  resetPublicHostsForTests,
  type CoreRequest,
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

export function formDataText(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string") {
    throw new TypeError(`Expected multipart field ${key} to contain text`);
  }

  return value;
}

export function requestBodyText(body: RequestInit["body"] | undefined): string {
  if (typeof body !== "string") {
    throw new TypeError("Expected request body to contain text");
  }

  return body;
}

export function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;

  return input instanceof URL ? input.href : input.url;
}

export async function responseJson(response: Response): Promise<any> {
  return await response.json();
}

export function stubPublicDns(address = "93.184.216.34"): () => void {
  const lookup = spyOn(dns, "lookup").mockResolvedValue([
    { address: address, family: 4, ttl: 30 },
  ]);

  return (): void => {
    lookup.mockRestore();
    resetPublicHostsForTests();
  };
}
