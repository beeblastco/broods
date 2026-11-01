// Forwarded from here so the OTLP collector's credentials never reach a client.
// AuthKit's proxy gates this path.
import {
  buildOtlpLogPayload,
  parseBeaconEvents,
  parseOtlpHeaders,
} from "@/app/lib/otlpLogs";
import {
  emitPostHogDashboardLog,
  flushPostHogDashboardLogs,
} from "@/instrumentation";

const MAX_BODY_BYTES = 64 * 1024;
const OTLP_TIMEOUT_MS = 5000;

export async function POST(request: Request): Promise<Response> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  // The header can lie: refuse an oversized body before buffering, then check the bytes.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  const raw = await request.bytes();
  if (raw.byteLength > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  let events;
  try {
    events = parseBeaconEvents(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (events.length === 0) return new Response(null, { status: 204 });

  emitPostHogDashboardLog("Dashboard performance beacon received", {
    event_count: events.length,
    telemetry: "performance_beacon",
  });

  if (!endpoint) {
    await flushPostHogDashboardLogs();

    return new Response(null, { status: 204 });
  }

  try {
    await fetch(`${endpoint}/v1/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
      },
      body: JSON.stringify(
        buildOtlpLogPayload(events, { serviceName: process.env.SERVICE_NAME }),
      ),
      signal: AbortSignal.timeout(OTLP_TIMEOUT_MS),
    });
  } catch {
    // Best-effort: telemetry never surfaces as an error in the app.
  } finally {
    await flushPostHogDashboardLogs();
  }

  return new Response(null, { status: 204 });
}
