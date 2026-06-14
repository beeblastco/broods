"use client";

/** Safe core service endpoint resolution for dashboard invoke/test URLs. */

const DEFAULT_CORE_BASE_URL = "https://app.beeblast.co";

export type CoreEndpoint =
    | { ok: true; httpBaseUrl: string; websocketBaseUrl: string }
    | { ok: false; message: string };

/** Resolve the configured core HTTP/WebSocket base URLs without throwing during render. */
export function resolveCoreEndpoint(): CoreEndpoint {
    const candidates = [
        process.env.NEXT_PUBLIC_FILTHY_PANTY_BASE_URL,
        process.env.NEXT_PUBLIC_AGENT_GATEWAY_URL,
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
        message: "Core endpoint is not configured with a valid absolute URL.",
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
