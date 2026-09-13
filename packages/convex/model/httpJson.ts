/**
 * JSON response helpers shared by the config plane and the CLI plane, so both
 * answer non-2xx with the same envelope.
 */

import { apiErrorBody, type ApiErrorInit } from "./apiError";

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function jsonError(
  status: number,
  message: string,
  init: ApiErrorInit = {},
  headers: Record<string, string> = {},
): Response {
  return json(apiErrorBody(status, message, init), status, headers);
}

/** 405 with the `Allow` header RFC 9110 requires. */
export function methodNotAllowed(allowedMethods: string[]): Response {
  return jsonError(
    405,
    `Method not allowed. Allowed: ${allowedMethods.join(", ")}.`,
    {},
    { Allow: allowedMethods.join(", ") },
  );
}

/**
 * RFC 6585 `Retry-After` plus the IETF RateLimit fields for a window with no
 * budget left. Floors at one second: a 429 that says retry in zero seconds
 * tells the client to hammer.
 */
export function rateLimitHeaders(
  limit: number,
  resetSeconds: number,
): Record<string, string> {
  const seconds = String(Math.max(1, Math.ceil(resetSeconds)));

  return {
    "Retry-After": seconds,
    "RateLimit-Limit": String(limit),
    "RateLimit-Remaining": "0",
    "RateLimit-Reset": seconds,
  };
}
