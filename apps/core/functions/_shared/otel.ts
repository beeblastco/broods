/**
 * OTel trace/log exporters for the harness, plus the per-invocation
 * observability context store. A no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset;
 * never throws into the agent path.
 */

import { trace, type Context, type Tracer } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { BasicTracerProvider, BatchSpanProcessor, RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";

export interface ObservabilityContext {
  accountId: string;
  project: string;
  environment: string;
  endpointId: string;
  agentId: string;
  conversationKey: string;
  traceId: string;
  /** OTel context containing the active root task span for log correlation. */
  otelContext: Context;
  /** Plaintext values that must be removed from every emitted log string. */
  secretValues: readonly string[];
}

// Module-level store — safe under Lambda's single-request-per-process model.
let _obsCtx: ObservabilityContext | null = null;

export function setObservabilityContext(ctx: ObservabilityContext | null): void {
  _obsCtx = ctx;
}

export function getObservabilityContext(): ObservabilityContext | null {
  return _obsCtx;
}

const _idGen = new RandomIdGenerator();

export function mintTraceId(): string {
  return _idGen.generateTraceId();
}

export function mintSpanId(): string {
  return _idGen.generateSpanId();
}

let _tracer: Tracer | null = null;
let _tracerProvider: BasicTracerProvider | null = null;
let _loggerProvider: LoggerProvider | null = null;
let _initialized = false;

// Idempotent; a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset. Reads the
// endpoint and OTEL_EXPORTER_OTLP_HEADERS ("K=V,K2=V2", e.g. Authorization=Basic …).
export function initOtel(): void {
  if (_initialized) return;
  _initialized = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const rawHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!endpoint) return;

  try {
    const headers: Record<string, string> = {};
    if (rawHeaders) {
      for (const pair of rawHeaders.split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0) {
          headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
      }
    }

    const traceExporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers: headers,
      timeoutMillis: 5000,
    });
    const resource = resourceFromAttributes({
      "service.name": process.env.AWS_LAMBDA_FUNCTION_NAME ?? "filthy-panty-core",
      "service.namespace": "beeblast",
    });
    const tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    trace.setGlobalTracerProvider(tracerProvider);
    _tracerProvider = tracerProvider;

    const logExporter = new OTLPLogExporter({
      url: `${endpoint}/v1/logs`,
      headers: headers,
      timeoutMillis: 5000,
    });
    const loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(logExporter)],
    });
    logs.setGlobalLoggerProvider(loggerProvider);
    _loggerProvider = loggerProvider;

    _tracer = trace.getTracer("filthy-panty-harness");
  } catch {
    // Best-effort: a failed init leaves the global API noop.
  }
}

// Returns a noop tracer if initOtel() has not run.
export function getTracer(): Tracer {
  if (_tracer) return _tracer;
  return trace.getTracer("filthy-panty-harness");
}

/** Tenant attributes shared by logs and spans and consumed by gateway filters. */
export function observabilityAttributes(
  ctx: Pick<ObservabilityContext, "accountId" | "project" | "environment" | "endpointId" | "agentId" | "conversationKey">,
): Record<string, string> {
  return {
    account_id: ctx.accountId,
    project: ctx.project,
    environment: ctx.environment,
    endpoint_id: ctx.endpointId,
    agent_id: ctx.agentId,
    conversation_key: ctx.conversationKey,
  };
}

/** Flush buffered logs and spans before Lambda returns and freezes the process. */
export async function forceFlushOtel(): Promise<void> {
  await Promise.allSettled([
    _tracerProvider?.forceFlush() ?? Promise.resolve(),
    _loggerProvider?.forceFlush() ?? Promise.resolve(),
  ]);
}

// Best-effort; `body` must already be redacted by the caller.
export function emitOtelLog(
  level: "INFO" | "WARN" | "ERROR" | "DEBUG",
  body: Record<string, unknown>,
): void {
  try {
    const ctx = getObservabilityContext();
    const logger = logs.getLogger("filthy-panty-harness");
    const severityMap: Record<string, SeverityNumber> = {
      DEBUG: SeverityNumber.DEBUG,
      INFO: SeverityNumber.INFO,
      WARN: SeverityNumber.WARN,
      ERROR: SeverityNumber.ERROR,
    };
    logger.emit({
      severityNumber: severityMap[level] ?? SeverityNumber.INFO,
      severityText: level,
      body: typeof body.message === "string" ? body.message : level,
      attributes: {
        ...body,
        ...(ctx ? observabilityAttributes(ctx) : {}),
        ...(ctx ? { trace_id: ctx.traceId } : {}),
      } as never,
      ...(ctx ? { context: ctx.otelContext } : {}),
      timestamp: typeof body.time === "string" ? new Date(body.time).getTime() : Date.now(),
    });
  } catch {
    // Best-effort: never propagate into the agent path.
  }
}
