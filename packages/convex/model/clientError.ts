/**
 * The caller's own mistake: bad input, a missing referenced resource, a name
 * clash. The config and CLI planes answer it with its status and message;
 * anything else is a 500 with a generic message.
 *
 * It is a ConvexError because a plain Error thrown inside `ctx.runQuery` or
 * `ctx.runMutation` reaches the HTTP action as a rewritten message, while a
 * ConvexError keeps its `data`.
 */

import { ConvexError, type Value } from "convex/values";
import { jsonError } from "./httpJson";

/** HTTP status for each code. Codes match `model/apiError` for that status. */
export const CLIENT_ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
} as const;

export type ClientErrorCode = keyof typeof CLIENT_ERROR_STATUS;

// A type alias, not an interface: ConvexError data must be a Convex `Value`,
// which needs the implicit index signature only aliases get.
export type ClientErrorData = {
  code: ClientErrorCode;
  message: string;
};

export class ClientError extends ConvexError<ClientErrorData> {
  constructor(message: string, code: ClientErrorCode = "invalid_request") {
    super({ code: code, message: message });
    // ConvexError would stringify the whole data object; logs and tests read
    // the plain sentence.
    this.message = message;
  }
}

/**
 * @param error anything a handler caught
 * @returns the client error's data, or null for any other error
 */
export function clientErrorData(error: unknown): ClientErrorData | null {
  if (!(error instanceof ConvexError)) return null;
  const data: Value = error.data;
  if (typeof data !== "object" || data === null) return null;
  if (!("code" in data) || !("message" in data)) return null;
  const code = data.code;
  const message = data.message;
  if (typeof message !== "string" || !isClientErrorCode(code)) return null;

  return { code: code, message: message };
}

/**
 * @param error anything a handler caught
 * @returns the client error answered with its own status and message, or null
 */
export function clientErrorResponse(error: unknown): Response | null {
  const data = clientErrorData(error);

  return data ? jsonError(CLIENT_ERROR_STATUS[data.code], data.message) : null;
}

function isClientErrorCode(code: Value | undefined): code is ClientErrorCode {
  return typeof code === "string" && Object.hasOwn(CLIENT_ERROR_STATUS, code);
}
