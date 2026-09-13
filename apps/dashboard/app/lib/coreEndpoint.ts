"use client";

// Only a production build falls back to the production gateway. A dev
// server with the variable unset used to dial it silently, and every ticket
// its stage's core minted was then refused by a gateway with other secrets.
const DEFAULT_CORE_BASE_URL =
  process.env.NODE_ENV === "production"
    ? "https://gateway.broods.app"
    : undefined;

export type CoreEndpoint =
  | { ok: true; httpBaseUrl: string; websocketBaseUrl: string }
  | { ok: false; message: string };

/**
 * Path of a deployed agent's run endpoint: stage scoped when both slugs are
 * known, bare otherwise. Append `/ws` for its socket.
 */
export function agentEndpointPath(scope: {
  endpointId: string;
  projectSlug?: string;
  stageSlug?: string;
}): string {
  const prefix =
    scope.projectSlug && scope.stageSlug
      ? `/projects/${encodeURIComponent(scope.projectSlug)}/stages/${encodeURIComponent(scope.stageSlug)}`
      : "";

  return `/v1${prefix}/agents/${encodeURIComponent(scope.endpointId)}`;
}

/** Resolve the configured core HTTP/WebSocket base URLs without throwing during render. */
export function resolveCoreEndpoint(): CoreEndpoint {
  const candidates = [
    process.env.NEXT_PUBLIC_BROODS_BASE_URL,
    DEFAULT_CORE_BASE_URL,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeHttpBaseUrl(candidate);
    if (!normalized) continue;
    const websocketBaseUrl = toWebSocketBaseUrl(normalized);
    if (!websocketBaseUrl) continue;

    return {
      ok: true,
      httpBaseUrl: normalized,
      websocketBaseUrl: websocketBaseUrl,
    };
  }

  return {
    ok: false,
    message:
      "Set NEXT_PUBLIC_BROODS_BASE_URL to the gateway in front of this stage's core.",
  };
}

function normalizeHttpBaseUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function toWebSocketBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}
