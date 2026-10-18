import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";

let posthogLoggerProvider: LoggerProvider | null = null;

/** Next.js instrumentation hook: warms the PostHog log provider on the Node runtime. */
export function register(): void {
  getPostHogLoggerProvider();
}

/** Emits only log lines purpose-written for this PostHog integration. */
export function emitPostHogDashboardLog(
  body: string,
  attributes: Record<string, string | number | boolean> = {},
): void {
  try {
    getPostHogLoggerProvider()?.getLogger("broods-dashboard-posthog").emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: body,
      attributes: attributes,
    });
  } catch {
    // Best-effort: logging must never affect the request path.
  }
}

export async function flushPostHogDashboardLogs(): Promise<void> {
  await posthogLoggerProvider?.forceFlush();
}

// A dedicated provider, never the global one: existing dashboard loggers are
// not exported. Null when PostHog is unconfigured or off the Node runtime.
function getPostHogLoggerProvider(): LoggerProvider | null {
  if (process.env.NEXT_RUNTIME !== "nodejs") return null;
  if (posthogLoggerProvider) return posthogLoggerProvider;

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (!key || !host) return null;

  const exporter = new OTLPLogExporter({
    url: `${host.replace(/\/+$/, "")}/i/v1/logs`,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  });
  posthogLoggerProvider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.SERVICE_NAME ?? "broods-dashboard",
    }),
    processors: [new BatchLogRecordProcessor({ exporter: exporter })],
  });

  return posthogLoggerProvider;
}
