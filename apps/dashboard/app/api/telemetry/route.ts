/**
 * Receives the browser's beacons: performance marks, forwarded to the OTLP
 * collector as logs, and product analytics events, forwarded to PostHog when
 * the operator turned analytics on. Both forwards happen here, not in the
 * browser, so no collector credential or PostHog key ships to a client.
 * AuthKit's proxy already gates this path, so only a signed-in session can
 * post.
 */
import {
  buildOtlpLogPayload,
  parseBeaconEvents,
  parseOtlpHeaders,
} from "@/app/lib/otlpLogs";
import {
  analyticsBatch,
  analyticsMode,
  parseAnalyticsEvents,
  type AnalyticsEvent,
} from "@broods/convex/model/productAnalytics";
import { createHash } from "node:crypto";
import type { PerfEvent } from "@/app/lib/perfReport";

const MAX_BODY_BYTES = 64 * 1024;
const FORWARD_TIMEOUT_MS = 5000;
const POSTHOG_DEFAULT_HOST = "https://eu.i.posthog.com";

export async function POST(request: Request): Promise<Response> {
  // Checked before reading so an oversized body is refused rather than
  // buffered, then again on the real bytes because the header can lie.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  const raw = await request.bytes();
  if (raw.byteLength > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response(null, { status: 400 });
  }

  // Best-effort, exactly like the harness exporter: telemetry must never
  // surface as an error in the app the user is using.
  await Promise.allSettled([
    forwardPerf(parseBeaconEvents(body)),
    forwardAnalytics(parseAnalyticsEvents(body)),
  ]);

  return new Response(null, { status: 204 });
}

/** Same contract as core's otel.ts: no endpoint configured, no exporter. */
async function forwardPerf(events: PerfEvent[]): Promise<void> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || events.length === 0) return;

  await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    },
    body: JSON.stringify(
      buildOtlpLogPayload(events, { serviceName: process.env.SERVICE_NAME }),
    ),
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
}

/**
 * Off unless `BROODS_ANALYTICS` names a mode and `POSTHOG_KEY` is set. The
 * install is the hash of its Convex URL, so every browser of one install
 * counts as that install and no person is named.
 */
async function forwardAnalytics(events: AnalyticsEvent[]): Promise<void> {
  const mode = analyticsMode(process.env.BROODS_ANALYTICS);
  const apiKey = process.env.POSTHOG_KEY;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (mode === null || !apiKey || !convexUrl || events.length === 0) return;

  const host = process.env.POSTHOG_HOST ?? POSTHOG_DEFAULT_HOST;
  await fetch(`${host}/batch/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      analyticsBatch(events, {
        apiKey: apiKey,
        instanceId: createHash("sha256")
          .update(convexUrl)
          .digest("hex")
          .slice(0, 16),
        source: "dashboard",
        at: Date.now(),
      }),
    ),
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
}
