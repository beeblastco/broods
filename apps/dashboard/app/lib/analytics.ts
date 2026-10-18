"use client";

/**
 * Product analytics from the browser: one event per feature use, posted to
 * `/api/telemetry` like the perf beacon. The route forwards it to PostHog
 * when the operator turned analytics on and drops it otherwise, so the
 * browser never knows a PostHog host or key. The events and what they may
 * carry are listed in `@broods/convex/model/productAnalytics`.
 */

import type { AnalyticsEvent } from "@broods/convex/model/productAnalytics";

const ENDPOINT = "/api/telemetry";

/** Send one event. A no-op during SSR; never throws into the caller's path. */
export function track(event: AnalyticsEvent): void {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({ analytics: [event] });

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
