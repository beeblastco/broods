"use client";

/**
 * Client-side performance beacon. Buffers marks and posts them to
 * `/api/telemetry`, which forwards to the OTLP collector — the collector's
 * credentials stay server-side and never reach the browser.
 */

const ENDPOINT = "/api/telemetry";
// sendBeacon caps a body at ~64 KB; these bounds keep a batch far under it and
// stop a runaway loop (a long-task storm) from beaconing without limit.
const MAX_BATCH = 32;
const MAX_BUFFERED = 128;
const FLUSH_DELAY_MS = 10_000;

/**
 * Budget per metric, in the metric's own unit. Every event carries
 * `over_budget`, so a Grafana alert is a filter rather than a threshold
 * duplicated in the query.
 */
export const PERF_BUDGETS: Record<string, number> = {
  "canvas.render": 200,
  "long-task": 200,
  "optimistic-save": 1000,
  "route.transition": 600,
  "side-panel.open": 300,
  "web-vital.CLS": 0.1,
  "web-vital.FCP": 1800,
  "web-vital.INP": 200,
  "web-vital.LCP": 2500,
  "web-vital.TTFB": 800,
};

/** Every static path segment the dashboard routes to; anything else is an id. */
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
  /** Metric key, e.g. `web-vital.LCP`. Matches a `PERF_BUDGETS` entry. */
  name: string;
  value: number;
  unit: PerfUnit;
  /** Route the mark was taken on, with ids replaced by their segment name. */
  route: string;
  attributes?: Record<string, string | number | boolean>;
  /** Epoch milliseconds. */
  at: number;
};

let buffer: PerfEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

/**
 * Queue one measurement. Safe to call from anywhere in the client — it no-ops
 * during SSR and never throws into the caller's path.
 */
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

  // Drop the oldest rather than grow without bound; the newest marks are the
  // ones a session is judged on.
  if (buffer.length > MAX_BUFFERED) buffer = buffer.slice(-MAX_BUFFERED);
  if (buffer.length >= MAX_BATCH) {
    flushPerf();

    return;
  }
  if (!flushTimer) flushTimer = setTimeout(flushPerf, FLUSH_DELAY_MS);
}

/** Ship whatever is buffered. Called on a full batch, on idle, and on unload. */
export function flushPerf(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;

  const batch = buffer.slice(0, MAX_BATCH);
  buffer = buffer.slice(MAX_BATCH);
  const body = JSON.stringify({ events: batch });

  // sendBeacon survives the page going away; fetch is the fallback when the
  // browser refuses the beacon (quota exceeded).
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

// Collapse ids out of a pathname (`/j97a.../dashboard` → `/[projectId]/dashboard`)
// at any depth, so no raw tenant id ever reaches the collector.
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

  // `visibilitychange` is the reliable end-of-session signal; `pagehide` covers
  // the bfcache path Safari takes instead.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPerf();
  });
  window.addEventListener("pagehide", flushPerf);
}
