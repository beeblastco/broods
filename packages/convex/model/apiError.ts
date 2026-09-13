/**
 * The API error contract: every non-2xx JSON body is
 * `{ error: { message, type, code, param? } }`.
 *
 * Core, the gateway and the config plane all answer with this, so the table
 * lives here rather than once per package.
 */

const BY_STATUS: Record<number, Pick<ApiError, "code" | "type">> = {
  400: { code: "invalid_request", type: "invalid_request_error" },
  401: { code: "unauthorized", type: "authentication_error" },
  403: { code: "forbidden", type: "permission_error" },
  404: { code: "not_found", type: "not_found_error" },
  405: { code: "method_not_allowed", type: "invalid_request_error" },
  409: { code: "conflict", type: "conflict_error" },
  410: { code: "gone", type: "not_found_error" },
  413: { code: "payload_too_large", type: "invalid_request_error" },
  415: { code: "unsupported_media_type", type: "invalid_request_error" },
  422: { code: "unprocessable_entity", type: "invalid_request_error" },
  429: { code: "rate_limited", type: "rate_limit_error" },
  500: { code: "internal_error", type: "api_error" },
  502: { code: "bad_gateway", type: "api_error" },
  503: { code: "service_unavailable", type: "overloaded_error" },
  504: { code: "gateway_timeout", type: "api_error" },
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
      type: byStatus(status).type,
      code: init.code ?? byStatus(status).code,
      ...(init.param !== undefined ? { param: init.param } : {}),
    },
  };
}

function byStatus(status: number): Pick<ApiError, "code" | "type"> {
  const known = BY_STATUS[status];
  if (known) return known;
  if (status >= 500) return { code: "internal_error", type: "api_error" };

  return { code: "invalid_request", type: "invalid_request_error" };
}
