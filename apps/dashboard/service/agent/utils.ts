import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import { gateway } from "@ai-sdk/gateway";

/** Maximum accepted request message length (100 KB). */
const MAX_MESSAGE_LENGTH = 100_000;

export type ParsedExecuteRequest = {
  message?: string;
  sessionId?: string;
  stream: boolean;
};

/** Structured JSON logger for the agent service. */
export const log = {
  info(msg: string, data?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: "info", msg: msg, ...data, ts: Date.now() }));
  },
  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: "warn", msg: msg, ...data, ts: Date.now() }));
  },
  error(msg: string, data?: Record<string, unknown>) {
    console.error(JSON.stringify({ level: "error", msg: msg, ...data, ts: Date.now() }));
  },
};

/** Cached env vars validated once at module load to fail fast on misconfiguration. */
const ENV = {
  CONVEX_SITE_URL: (() => {
    const url = Bun.env.CONVEX_SITE_URL;
    if (!url) throw new Error("CONVEX_SITE_URL is required");

    return url.replace(/\/+$/, "");
  })(),
  GATEWAY_SHARED_SECRET: (() => {
    const secret = Bun.env.GATEWAY_SHARED_SECRET;
    if (!secret) throw new Error("GATEWAY_SHARED_SECRET is required");

    return secret;
  })(),
  AGENT_API_KEY_PEPPER: (() => {
    const pepper = Bun.env.AGENT_API_KEY_PEPPER;
    if (!pepper) {
      log.warn("startup:missing_pepper", { msg: "AGENT_API_KEY_PEPPER not set; using empty pepper" });
    }

    return pepper ?? "";
  })(),
  CORS_ALLOWED_ORIGIN: Bun.env.CORS_ALLOWED_ORIGIN ?? "*",
  SANDBOX_SERVICE_URL: (() => {
    const url = Bun.env.SANDBOX_SERVICE_URL;
    if (!url) throw new Error("SANDBOX_SERVICE_URL is required");

    return url.replace(/\/+$/, "");
  })(),
  SANDBOX_SHARED_SECRET: (() => {
    const secret = Bun.env.SANDBOX_SHARED_SECRET;
    if (!secret) throw new Error("SANDBOX_SHARED_SECRET is required");

    return secret;
  })(),
};

/** Returns the cached Convex site URL. */
export function getConvexSiteUrl(): string {
  return ENV.CONVEX_SITE_URL;
}

/** Returns the cached gateway shared secret. */
export function getGatewaySecret(): string {
  return ENV.GATEWAY_SHARED_SECRET;
}

/**
 * Calls a Convex HTTP gateway endpoint with shared-secret auth.
 * @param path HTTP route path (e.g. "/api/gateway/sessions/create")
 * @param args JSON-serializable arguments for the internal function
 * @returns Parsed JSON response
 */
export async function callGateway<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${ENV.CONVEX_SITE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Secret": ENV.GATEWAY_SHARED_SECRET,
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gateway call failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<T>;
}


/**
 * Extracts the bearer token from an Authorization header.
 * @param authorizationHeader Raw Authorization header value
 * @returns Token string or null if missing/malformed
 */
export function parseBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) {
    return null;
  }
  if (!authorizationHeader.startsWith("Bearer ")) {
    return null;
  }

  return authorizationHeader.slice("Bearer ".length).trim() || null;
}

/**
 * Parses and validates the execute request payload.
 * @param payload Unknown request body
 * @returns Ok result with parsed value or error string
 */
export function parseExecutePayload(
  payload: unknown,
): { ok: true; value: ParsedExecuteRequest } | { ok: false; error: string } {
  if (!isRecord(payload)) {
    return { ok: false, error: "Body must be a JSON object" };
  }

  const message = typeof payload.message === "string" ? payload.message.trim() : undefined;
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
  const streamField = payload.stream;
  const stream = typeof streamField === "boolean" ? streamField : true;

  if (!message && !sessionId) {
    return { ok: false, error: "Body must include message or sessionId" };
  }

  if (message && message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` };
  }

  return {
    ok: true,
    value: {
      message: message,
      sessionId: sessionId,
      stream: stream,
    },
  };
}

/**
 * Maps known error messages to HTTP status codes.
 * @param error Unknown error value
 * @returns HTTP status code
 */
export function resolveStatusCode(error: unknown): number {
  const message = toErrorMessage(error);
  if (message === "Not found") {
    return 404;
  }
  if (message === "Unauthorized") {
    return 401;
  }
  if (message === "Revoked") {
    return 403;
  }
  if (message.includes("Provide message") || message.includes("sessionId")) {
    return 400;
  }

  return 500;
}


/** CORS headers applied to all gateway responses. Origin is configurable via CORS_ALLOWED_ORIGIN env var. */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ENV.CORS_ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "X-Session-Id, X-Task-Id",
};

/** Returns a JSON response with the given status and payload. */
export function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status: status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}


/**
 * Hashes an API key with a pepper using SHA-256.
 * @param apiKey Raw API key
 * @returns Hex-encoded hash string
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  const payload = `${ENV.AGENT_API_KEY_PEPPER}:${apiKey}`;
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return bytesToHex(new Uint8Array(digest));
}

/**
 * Compares two strings in constant time using native crypto to prevent timing attacks.
 * Both strings are padded to equal length before comparison to avoid leaking length info.
 * @param a First string
 * @param b Second string
 * @returns True if equal
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);

  // Pad both to the same length so the comparison doesn't leak length info
  const aPadded = Buffer.alloc(maxLen);
  const bPadded = Buffer.alloc(maxLen);
  Buffer.from(aBytes).copy(aPadded);
  Buffer.from(bBytes).copy(bPadded);

  // Use native constant-time comparison, then verify lengths actually matched
  return cryptoTimingSafeEqual(aPadded, bPadded) && aBytes.length === bBytes.length;
}

/** Converts a Uint8Array to a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}



/** Returns the cached sandbox service base URL. */
export function getSandboxUrl(): string {
  return ENV.SANDBOX_SERVICE_URL;
}

/** Returns the cached sandbox shared secret. */
export function getSandboxSecret(): string {
  return ENV.SANDBOX_SHARED_SECRET;
}


/** Returns the message string from any thrown value. */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Extracted details from an AI SDK provider/gateway error. */
export type ProviderErrorInfo = {
  statusCode: number;
  provider: string | undefined;
  modelId: string | undefined;
  message: string;
};

/**
 * Extracts a user-friendly error from AI SDK provider/gateway errors.
 * Walks the error cause chain looking for statusCode and routing metadata.
 * @param error Unknown error value
 * @returns Structured error info or undefined if not a provider error
 */
export function resolveProviderError(error: unknown): ProviderErrorInfo | undefined {
  let current: unknown = error;
  let statusCode: number | undefined;
  let responseBody: string | undefined;

  // Walk the cause chain to find the deepest error with statusCode
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) {
      const errorRecord = current as unknown as Record<string, unknown>;
      if (typeof errorRecord.statusCode === "number") {
        statusCode = errorRecord.statusCode;
      }
      if (typeof errorRecord.responseBody === "string") {
        responseBody = errorRecord.responseBody;
      }
      current = errorRecord.cause ?? undefined;
    } else {
      break;
    }
  }

  if (statusCode === undefined) {
    return undefined;
  }

  // Try to parse routing metadata from the gateway response
  let provider: string | undefined;
  let modelId: string | undefined;
  if (responseBody) {
    try {
      const parsed = JSON.parse(responseBody);
      const routing = parsed?.providerMetadata?.gateway?.routing;
      if (routing) {
        provider = routing.resolvedProvider;
        modelId = routing.originalModelId;
      }
    } catch {
      // Ignore parse failures
    }
  }

  const message = formatProviderError(statusCode, provider, modelId);

  return { statusCode: statusCode, provider: provider, modelId: modelId, message: message };
}

/** Formats a human-readable error message for provider failures. */
function formatProviderError(
  statusCode: number,
  provider: string | undefined,
  modelId: string | undefined,
): string {
  const modelLabel = modelId ?? "the selected model";
  const providerLabel = provider ? ` (via ${provider})` : "";

  if (statusCode === 405) {
    return (
      `Model "${modelLabel}"${providerLabel} does not support the requested features ` +
      `(tool calling or structured output). Disable these features or use a compatible model.`
    );
  }
  if (statusCode === 401 || statusCode === 403) {
    return `Authentication failed for "${modelLabel}"${providerLabel}. Check your API credentials.`;
  }
  if (statusCode === 429) {
    return `Rate limit exceeded for "${modelLabel}"${providerLabel}. Try again later.`;
  }
  if (statusCode === 404) {
    return `Model "${modelLabel}"${providerLabel} was not found. Verify the model ID is correct.`;
  }

  return `Provider error (${statusCode}) for "${modelLabel}"${providerLabel}.`;
}


/** Returns true if value is a non-null, non-array object (plain record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/**
 * Resolves a model ID to an AI SDK provider model via Vercel AI Gateway.
 * @param modelId Vercel AI Gateway model ID (e.g. "google/gemini-2.0-flash")
 * @returns AI SDK language model routed through Vercel AI Gateway
 */
export function resolveModel(modelId: string) {
  return gateway(modelId);
}
