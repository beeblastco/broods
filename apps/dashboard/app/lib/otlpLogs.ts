/**
 * Builds OTLP/HTTP JSON log records for the browser performance beacon. The
 * dashboard has no OTel SDK: one `fetch` of this payload to the collector's
 * `/v1/logs` is the whole exporter, and it keeps core's env-var contract
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`).
 */
import type { PerfEvent, PerfUnit } from "@/app/lib/perfReport";

/** Fallback when SERVICE_NAME is unset; the pods set it per stage, as core does. */
const DEFAULT_SERVICE_NAME = "broods-dashboard";
const SCOPE_NAME = "broods-dashboard-rum";
/** OTLP severityNumber for INFO. */
const SEVERITY_INFO = 9;

const MAX_EVENTS = 32;
const MAX_ATTRIBUTES = 12;
const MAX_NAME_CHARS = 64;
const MAX_ROUTE_CHARS = 128;
const MAX_ATTRIBUTE_CHARS = 128;
const UNITS: PerfUnit[] = ["ms", "score", "count"];

type OtlpValue =
  { stringValue: string } | { doubleValue: number } | { boolValue: boolean };
type OtlpAttribute = { key: string; value: OtlpValue };

/** Parses core's `OTEL_EXPORTER_OTLP_HEADERS` form: `K=V,K2=V2`. */
export function parseOtlpHeaders(
  raw: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;

  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  return headers;
}

// `service.name` is the only resource attribute, carrying the stage as core does:
// the collector promotes those to Loki labels, where per-project keys would blow up.
export function buildOtlpLogPayload(
  events: PerfEvent[],
  context: { serviceName?: string },
): { resourceLogs: unknown[] } {
  const resourceAttributes: OtlpAttribute[] = [
    {
      key: "service.name",
      value: { stringValue: context.serviceName || DEFAULT_SERVICE_NAME },
    },
  ];

  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope: { name: SCOPE_NAME },
            logRecords: events.map(toLogRecord),
          },
        ],
      },
    ],
  };
}

function toLogRecord(event: PerfEvent) {
  const attributes: OtlpAttribute[] = [
    { key: "metric", value: { stringValue: event.name } },
    { key: "value", value: { doubleValue: event.value } },
    { key: "unit", value: { stringValue: event.unit } },
    { key: "route", value: { stringValue: event.route } },
  ];
  for (const [key, value] of Object.entries(event.attributes ?? {})) {
    attributes.push({ key: key, value: toOtlpValue(value) });
  }

  return {
    // BigInt, not string concatenation: a large `at` renders in exponential
    // notation and would emit a malformed timestamp.
    timeUnixNano: (BigInt(Math.round(event.at)) * BigInt(1_000_000)).toString(),
    severityNumber: SEVERITY_INFO,
    severityText: "INFO",
    body: { stringValue: event.name },
    attributes: attributes,
  };
}

function toOtlpValue(value: string | number | boolean): OtlpValue {
  if (typeof value === "number") return { doubleValue: value };
  if (typeof value === "boolean") return { boolValue: value };

  return { stringValue: value };
}

// Trust boundary: the beacon is client-supplied, so only this bounded shape is
// accepted and every string is truncated before it can reach the collector.
export function parseBeaconEvents(body: unknown): PerfEvent[] {
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
      at <= 0 ||
      at > Number.MAX_SAFE_INTEGER ||
      !UNITS.includes(unit as PerfUnit)
    ) {
      continue;
    }

    events.push({
      name: name.slice(0, MAX_NAME_CHARS),
      value: value,
      unit: unit as PerfUnit,
      route: route.slice(0, MAX_ROUTE_CHARS),
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
  for (const [key, entry] of Object.entries(value).slice(0, MAX_ATTRIBUTES)) {
    if (typeof entry === "string")
      attributes[key] = entry.slice(0, MAX_ATTRIBUTE_CHARS);
    else if (typeof entry === "number" && Number.isFinite(entry))
      attributes[key] = entry;
    else if (typeof entry === "boolean") attributes[key] = entry;
  }

  return attributes;
}
