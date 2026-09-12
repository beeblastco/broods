/**
 * The API error contract: every non-2xx JSON body is
 * `{ error: { message, type, code, param? } }`.
 *
 * Core, the gateway and the config plane all answer with this, so the table
 * lives here rather than once per package.
 */

const DEFAULT_CODE_BY_STATUS: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  422: "unprocessable_entity",
  429: "rate_limited",
  500: "internal_error",
  502: "bad_gateway",
  503: "service_unavailable",
  504: "gateway_timeout",
};

const TYPE_BY_STATUS: Record<number, ApiErrorType> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  405: "invalid_request_error",
  409: "conflict_error",
  413: "invalid_request_error",
  415: "invalid_request_error",
  422: "invalid_request_error",
  429: "rate_limit_error",
  500: "api_error",
  502: "api_error",
  503: "overloaded_error",
  504: "api_error",
};

export type ApiErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "conflict_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export interface ApiError {
  message: string;
  type: ApiErrorType;
  /** Stable across releases, unlike `message`. Branch on this. */
  code: string;
  param?: string;
}

export interface ApiErrorBody {
  error: ApiError;
}

export interface ApiErrorInit {
  code?: string;
  param?: string;
}

export function apiErrorBody(
  status: number,
  message: string,
  init: ApiErrorInit = {},
): ApiErrorBody {
  return {
    error: {
      message: message,
      type: apiErrorType(status),
      code: init.code ?? defaultApiErrorCode(status),
      ...(init.param !== undefined ? { param: init.param } : {}),
    },
  };
}

function apiErrorType(status: number): ApiErrorType {
  return TYPE_BY_STATUS[status] ?? fallbackByStatusClass(status).type;
}

function defaultApiErrorCode(status: number): string {
  return DEFAULT_CODE_BY_STATUS[status] ?? fallbackByStatusClass(status).code;
}

function fallbackByStatusClass(status: number): {
  code: string;
  type: ApiErrorType;
} {
  if (status >= 500) return { code: "internal_error", type: "api_error" };

  return { code: "invalid_request", type: "invalid_request_error" };
}
