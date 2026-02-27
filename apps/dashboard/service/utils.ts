import { gateway } from "@ai-sdk/gateway";
import { ConvexHttpClient } from "convex/browser";


export type ParsedExecuteRequest = {
  message?: string;
  sessionId?: string;
  stream: boolean;
};


/** Creates a ConvexHttpClient from the NEXT_PUBLIC_CONVEX_URL environment variable. */
export function createConvexClient(): ConvexHttpClient {
  const convexUrl = Bun.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error("NEXT_PUBLIC_CONVEX_URL is required");
  }

  return new ConvexHttpClient(convexUrl);
}

/** Returns the gateway shared secret, throwing if not set. */
export function getGatewaySecret(): string {
  const gatewaySecret = Bun.env.GATEWAY_SHARED_SECRET;
  if (!gatewaySecret) {
    throw new Error("GATEWAY_SHARED_SECRET is required");
  }

  return gatewaySecret;
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


/** CORS headers applied to all gateway responses. */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
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
  const pepper = Bun.env.AGENT_API_KEY_PEPPER ?? "";
  const payload = `${pepper}:${apiKey}`;
  const encoded = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return bytesToHex(new Uint8Array(digest));
}

/**
 * Compares two strings in constant time to prevent timing attacks.
 * @param a First string
 * @param b Second string
 * @returns True if equal
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return diff === 0;
}

/** Converts a Uint8Array to a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}



/** Returns the message string from any thrown value. */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/** Returns true if value is a non-null object (plain record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


/**
 * Resolves a model ID to an AI SDK provider model via Vercel AI Gateway.
 * @param modelId Vercel AI Gateway model ID (e.g. "google/gemini-2.0-flash")
 * @returns AI SDK language model routed through Vercel AI Gateway
 */
export function resolveModel(modelId: string) {
  return gateway(modelId);
}
