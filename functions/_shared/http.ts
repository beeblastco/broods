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
): LambdaResponse {
  return jsonResponse(statusCode, {
    error,
    ...details,
  });
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
