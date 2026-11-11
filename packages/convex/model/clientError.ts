import { ConvexError, type Value } from "convex/values";
import { jsonError } from "./httpJson";

// Codes match `model/apiError`, but for `manifest_conflict` (CLI re-reads and retries) and
// `payment_required` (dashboard offers an upgrade or a seat).
export const CLIENT_ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  payment_required: 402,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  manifest_conflict: 409,
} as const;

export type ClientErrorCode = keyof typeof CLIENT_ERROR_STATUS;

// An alias, not an interface: ConvexError data must be a `Value`, which needs an index signature.
export type ClientErrorData = {
  code: ClientErrorCode;
  message: string;
};

// A ConvexError, since a plain Error thrown in `ctx.runQuery` reaches the HTTP action rewritten.
export class ClientError extends ConvexError<ClientErrorData> {
  constructor(message: string, code: ClientErrorCode = "invalid_request") {
    super({ code: code, message: message });
    // ConvexError sets message to the stringified data; logs and tests read the sentence.
    this.message = message;
  }
}

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

export function clientErrorResponse(error: unknown): Response | null {
  const data = clientErrorData(error);

  return data
    ? jsonError(CLIENT_ERROR_STATUS[data.code], data.message, {
        code: data.code,
      })
    : null;
}

function isClientErrorCode(code: Value | undefined): code is ClientErrorCode {
  return typeof code === "string" && Object.hasOwn(CLIENT_ERROR_STATUS, code);
}
