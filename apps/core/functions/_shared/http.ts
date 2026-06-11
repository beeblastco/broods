/**
 * Shared HTTP request and response helpers for Lambda Function URL handlers.
 * Keep generic parsing and response shaping here, not route-specific logic.
 */

import type { LambdaFunctionURLEvent } from "aws-lambda";
import type { LambdaResponse } from "./runtime.ts";

export function jsonResponse(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): LambdaResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export function textResponse(
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): LambdaResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    },
    body,
  };
}

export function errorResponse(
  statusCode: number,
  error: string,
  details: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): LambdaResponse {
  return jsonResponse(statusCode, {
    error,
    ...details,
  }, headers);
}

export function parseJsonBody(event: LambdaFunctionURLEvent): unknown {
  const body = decodeBody(event.body, event.isBase64Encoded);
  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function normalizeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    }
  }

  return normalized;
}

export function normalizePath(rawPath: string): string {
  return rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
}

export function decodeBody(body: string | undefined, isBase64Encoded?: boolean): string {
  const raw = body ?? "";
  return isBase64Encoded ? Buffer.from(raw, "base64").toString("utf-8") : raw;
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
