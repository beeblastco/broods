/**
 * Receives the browser performance beacon and forwards it to the OTLP
 * collector as logs. The forward happens here, not in the browser, so the
 * collector's basic-auth credentials never ship to a client. AuthKit's proxy
 * already gates this path, so only a signed-in session can post.
 */
import {
  buildOtlpLogPayload,
  parseBeaconEvents,
  parseOtlpHeaders,
} from "@/app/lib/otlpLogs";

const MAX_BODY_BYTES = 64 * 1024;
const OTLP_TIMEOUT_MS = 5000;

export async function POST(request: Request) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // Same contract as core's otel.ts: no endpoint configured, no exporter.
  if (!endpoint) return new Response(null, { status: 204 });

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

  let events;
  try {
    events = parseBeaconEvents(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (events.length === 0) return new Response(null, { status: 204 });

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
    // Best-effort, exactly like the harness exporter: telemetry must never
    // surface as an error in the app the user is using.
  }

  return new Response(null, { status: 204 });
}
