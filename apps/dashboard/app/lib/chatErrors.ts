/**
 * Maps raw agent-chat transport errors to something a person can act on.
 *
 * The Test tab receives failures as opaque strings: sometimes the core
 * service's JSON error body verbatim (the gateway forwards `response.text()`
 * into the WebSocket error frame), sometimes a bare message. This is the
 * single place that turns those into one plain-English sentence plus at most
 * one action. The raw text is always preserved for a "Show details"
 * disclosure — never rendered as the headline.
 */

export type ChatErrorActionKind =
  "open-details" | "open-env-vars" | "retry" | "none";

export interface ChatErrorAction {
  label: string;
  kind: ChatErrorActionKind;
}

export interface ChatErrorPresentation {
  /** One short human sentence. */
  title: string;
  /** Optional second line, still plain language. */
  detail?: string;
  /** At most one primary action. */
  action?: ChatErrorAction;
  /** The original error text, shown only behind a disclosure. */
  raw: string;
}

/** The core service's error body shape (`errorResponse` in shared/http.ts). */
interface BackendErrorPayload {
  error?: string;
  code?: string;
}

function parseBackendPayload(raw: string): BackendErrorPayload | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as BackendErrorPayload;

    return {
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      code: typeof parsed.code === "string" ? parsed.code : undefined,
    };
  } catch {
    return null;
  }
}

/** The runtime's stream error frame (`{type:"error", error}` after `data:`). */
interface RuntimeStreamErrorFrame {
  type?: unknown;
  error?: unknown;
}

/**
 * Extract the message from a runtime stream error frame. The runtime frames
 * stream errors as `{type:"error", error}` while the AI SDK's
 * `uiMessageChunkSchema` requires `errorText` — so these frames fail schema
 * validation and real failures were silently dropped. Callers re-frame the
 * message as an `errorText` chunk instead of losing it.
 */
export function runtimeStreamErrorText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const frame = value as RuntimeStreamErrorFrame;

  return frame.type === "error" && typeof frame.error === "string"
    ? frame.error
    : null;
}

/**
 * Chunk-ordering noise from `readUIMessageStream` ("Received text-end for
 * missing text part…"). An internal protocol detail, never a user-facing
 * condition — callers should log it and, if a reply already rendered, show
 * nothing at all.
 */
export function isStreamProtocolError(message: string): boolean {
  return (
    /missing (?:text|reasoning) part/i.test(message) ||
    /"(?:text|reasoning)-(?:start|end|delta)" chunk/i.test(message)
  );
}

const NETWORK_ERROR_SNIPPETS = [
  "Cannot reach core service",
  "Failed to fetch",
  "WebSocket connection timeout",
  "WebSocket transport error",
  "WebSocket closed before opening",
  "WebSocket connection closed",
  "timed out",
  "Run start timed out",
];

function isProviderKeyError(text: string): boolean {
  // Deploy-time shape: `config.provider.<name>.apiKey is required`.
  if (text.includes("config.provider.") && /api ?key/i.test(text)) {
    return true;
  }

  // Provider-side rejections of the configured key.
  return (
    /api ?key/i.test(text) &&
    /invalid|not valid|missing|incorrect|expired|revoked|unauthenticated/i.test(
      text,
    )
  );
}

/** Resolve a raw chat transport error into what the transcript renders. */
export function resolveChatError(raw: string): ChatErrorPresentation {
  const payload = parseBackendPayload(raw);
  const code = payload?.code;
  const text = payload?.error ?? raw;

  if (
    code === "public_access_disabled" ||
    text.includes("not publicly accessible")
  ) {
    return {
      title: "This agent isn't reachable yet.",
      detail: "Turn on Public access in Details to test it.",
      action: { label: "Open Details", kind: "open-details" },
      raw: raw,
    };
  }

  if (text.includes("Agent not found")) {
    return {
      title: "This agent isn't deployed yet.",
      detail: "Check its deployment in Details, then try again.",
      action: { label: "Open Details", kind: "open-details" },
      raw: raw,
    };
  }

  if (isProviderKeyError(text)) {
    return {
      title: "The model API key for this agent is missing or wrong.",
      detail: "Check the key this agent points at in Environment variables.",
      action: {
        label: "Open Environment variables",
        kind: "open-env-vars",
      },
      raw: raw,
    };
  }

  if (
    text.trim() === "Unauthorized" ||
    /failed with status 40[13]/.test(text)
  ) {
    return {
      title: "This stage's runtime key isn't valid.",
      detail: "Rotate the key in Details, then send again.",
      action: { label: "Open Details", kind: "open-details" },
      raw: raw,
    };
  }

  if (NETWORK_ERROR_SNIPPETS.some((snippet) => text.includes(snippet))) {
    return {
      title: "Couldn't reach the agent.",
      detail: "Check your connection, then try again.",
      action: { label: "Retry", kind: "retry" },
      raw: raw,
    };
  }

  // Never render an unmapped payload as the primary message.
  return {
    title: "Something went wrong talking to this agent.",
    raw: raw,
  };
}
