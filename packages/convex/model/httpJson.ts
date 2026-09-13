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
