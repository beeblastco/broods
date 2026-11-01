"use client";

// Posts through `/api/telemetry` so the collector's credentials never reach the browser.
const ENDPOINT = "/api/telemetry";
// sendBeacon caps a body at ~64 KB, and a long-task storm must not beacon without limit.
const MAX_BATCH = 32;
const MAX_BUFFERED = 128;
const FLUSH_DELAY_MS = 10_000;

// e2e/perf fails a page over this. CI cold loads take 850 to 1000 ms (JS, then one Convex
// round trip for auth and one for data), so a page needing another round trip fails.
export const PAGE_RENDER_BUDGET_MS = 1000;

// Kept apart from the probe budget: loosening that must not loosen the Grafana alert.
export const FIELD_RENDER_BUDGET_MS = 1000;

export const PERF_BUDGETS: Record<string, number> = {
  "canvas.render": 200,
  "first-load.canvas": PAGE_RENDER_BUDGET_MS,
  "long-task": 200,
  "optimistic-save": 1000,
  "route.transition": FIELD_RENDER_BUDGET_MS,
  "side-panel.open": 300,
  "web-vital.CLS": 0.1,
  "web-vital.FCP": FIELD_RENDER_BUDGET_MS,
  "web-vital.INP": 200,
  "web-vital.LCP": FIELD_RENDER_BUDGET_MS,
  "web-vital.TTFB": 800,
};

const KNOWN_SEGMENTS = new Set([
  "account",
  "auth",
  "callback",
  "cli-auth",
  "dashboard",
  "healthz",
  "org",
  "projects",
  "sandbox",
  "scheduler",
  "settings",
  "sign-in",
  "start",
]);

export type PerfUnit = "ms" | "score" | "count";

export type PerfEvent = {
  name: string;
  value: number;
  unit: PerfUnit;
  route: string;
  attributes?: Record<string, string | number | boolean>;
  at: number;
};

let buffer: PerfEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

export function reportPerf(
  name: string,
  value: number,
  options: {
    unit?: PerfUnit;
    attributes?: Record<string, string | number | boolean>;
  } = {},
): void {
  if (typeof window === "undefined" || !Number.isFinite(value)) return;

  bindFlushListeners();
  const budget = PERF_BUDGETS[name];
  buffer.push({
    name: name,
    value: value,
    unit: options.unit ?? "ms",
    route: routePattern(window.location.pathname),
    attributes: {
      ...options.attributes,
      ...(budget === undefined ? {} : { over_budget: value > budget }),
    },
    at: Date.now(),
  });

  if (buffer.length > MAX_BUFFERED) buffer = buffer.slice(-MAX_BUFFERED);
  if (buffer.length >= MAX_BATCH) {
    flushPerf();

    return;
  }
  if (!flushTimer) flushTimer = setTimeout(flushPerf, FLUSH_DELAY_MS);
}

export function flushPerf(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;

  const batch = buffer.slice(0, MAX_BATCH);
  buffer = buffer.slice(MAX_BATCH);
  const body = JSON.stringify({ events: batch });

  // sendBeacon survives unload; fetch covers a beacon the browser refuses over quota.
  if (
    navigator.sendBeacon?.(
      ENDPOINT,
      new Blob([body], { type: "application/json" }),
    )
  ) {
    return;
  }
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body,
    keepalive: true,
  }).catch(() => {});
}

// No raw tenant id may reach the collector.
export function routePattern(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  return `/${segments
    .map((segment, index) =>
      KNOWN_SEGMENTS.has(segment)
        ? segment
        : index === 0
          ? "[projectId]"
          : "[id]",
    )
    .join("/")}`;
}

function bindFlushListeners(): void {
  if (listenersBound) return;
  listenersBound = true;

  // `pagehide` covers the bfcache path Safari takes instead of `visibilitychange`.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPerf();
  });
  window.addEventListener("pagehide", flushPerf);
}
