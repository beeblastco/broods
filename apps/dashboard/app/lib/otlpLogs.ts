/**
 * Builds OTLP/HTTP JSON log records for the browser performance beacon. The
 * dashboard has no OTel SDK: one `fetch` of this payload to the collector's
 * `/v1/logs` is the whole exporter, and it keeps core's env-var contract
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`).
 */
import type { PerfEvent } from "@/app/lib/perfReport";

/** Fallback when SERVICE_NAME is unset; the pods set it per stage, as core does. */
const DEFAULT_SERVICE_NAME = "broods-dashboard";
const SCOPE_NAME = "broods-dashboard-rum";
/** OTLP severityNumber for INFO. */
const SEVERITY_INFO = 9;

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

/**
 * Wraps a beacon batch as one OTLP `resourceLogs` payload. `service.name` is the
 * only resource attribute, carrying the stage the way core does
 * (`broods-core-pod` / `dev-broods-core-pod`): the collector promotes resource
 * attributes to Loki index labels, so a per-project key here would be unbounded
 * cardinality. Everything else rides as record attributes, which stay queryable
 * structured metadata.
 */
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
    timeUnixNano: `${Math.round(event.at)}000000`,
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
