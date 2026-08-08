/**
 * Receives the browser performance beacon and forwards it to the OTLP
 * collector as logs. The forward happens here, not in the browser, so the
 * collector's basic-auth credentials never ship to a client. AuthKit's proxy
 * already gates this path, so only a signed-in session can post.
 */
import { buildOtlpLogPayload, parseOtlpHeaders } from "@/app/lib/otlpLogs";
import type { PerfEvent, PerfUnit } from "@/app/lib/perfReport";

const MAX_EVENTS = 32;
const MAX_BODY_BYTES = 64 * 1024;
const UNITS: PerfUnit[] = ["ms", "score", "count"];
const OTLP_TIMEOUT_MS = 5000;

export async function POST(request: Request) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // Same contract as core's otel.ts: no endpoint configured, no exporter.
  if (!endpoint) return new Response(null, { status: 204 });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  let events: PerfEvent[];
  try {
    events = parseEvents(JSON.parse(raw));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (events.length === 0) return new Response(null, { status: 204 });

  const payload = buildOtlpLogPayload(events, {
    serviceName: process.env.SERVICE_NAME,
  });

  try {
    await fetch(`${endpoint}/v1/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(OTLP_TIMEOUT_MS),
    });
  } catch {
    // Best-effort, exactly like the harness exporter: telemetry must never
    // surface as an error in the app the user is using.
  }

  return new Response(null, { status: 204 });
}

/** Accepts only the bounded shape the beacon sends; anything else is dropped. */
function parseEvents(body: unknown): PerfEvent[] {
  if (typeof body !== "object" || body === null) return [];
  const list = (body as { events?: unknown }).events;
  if (!Array.isArray(list)) return [];

  const events: PerfEvent[] = [];
  for (const entry of list.slice(0, MAX_EVENTS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const { name, value, unit, route, at } = candidate;
    if (
      typeof name !== "string" ||
      typeof route !== "string" ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      typeof at !== "number" ||
      !Number.isFinite(at) ||
      !UNITS.includes(unit as PerfUnit)
    ) {
      continue;
    }

    events.push({
      name: name.slice(0, 64),
      value: value,
      unit: unit as PerfUnit,
      route: route.slice(0, 128),
      attributes: parseAttributes(candidate.attributes),
      at: at,
    });
  }

  return events;
}

function parseAttributes(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 12)) {
    if (typeof entry === "string") attributes[key] = entry.slice(0, 128);
    else if (typeof entry === "number" && Number.isFinite(entry))
      attributes[key] = entry;
    else if (typeof entry === "boolean") attributes[key] = entry;
  }

  return attributes;
}
