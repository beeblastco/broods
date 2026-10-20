/**
 * OTel trace/log exporters for the harness, plus the per-request
 * observability context store. A no-op when no exporter is configured; never
 * throws into the agent path.
 */

import { OpenTelemetry } from "@ai-sdk/otel";
import { PostHogSpanProcessor } from "@posthog/ai/otel";
import { trace, type Context, type Tracer } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  RandomIdGenerator,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";
import { AsyncLocalStorage } from "node:async_hooks";
import { analyticsSessionTag } from "./run-token.ts";

// AI SDK span attributes that carry what users or agents wrote. Dropped before
// PostHog even when a call site forgets `recordInputs`/`recordOutputs: false`.
const USER_CONTENT_ATTRIBUTES = new Set([
  "ai.decision.answers",
  "ai.decision.questions",
  "ai.documents",
  "ai.embedding",
  "ai.embeddings",
  "ai.prompt",
  "ai.prompt.messages",
  "ai.prompt.tools",
  "ai.request.text",
  "ai.response.files",
  "ai.response.object",
  "ai.response.reasoning",
  "ai.response.text",
  "ai.value",
  "ai.values",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.tool.definitions",
]);

export interface ObservabilityContext {
  accountId: string;
  project: string;
  stage: string;
  endpointId: string;
  agentId: string;
  conversationKey: string;
  traceId: string;
  /** OTel context containing the active root task span for log correlation. */
  otelContext: Context;
  /** Plaintext values that must be removed from every emitted log string. */
  secretValues: readonly string[];
}

// The observability context (per-tenant secretValues for log redaction + NATS
// routing tags) must be request-scoped. The self-hosted container serves many
// tenants concurrently in one process, so a module global would let one request's
// secrets/tags clobber another's mid-flight. Each container entry point opens a
// scope via runWithObservabilityScope; setters write into that request's cell.
// When no scope is active, the module global is used as a narrow fallback for
// tests and legacy direct call sites.
interface ObservabilityCell {
  current: ObservabilityContext | null;
}

const _obsStore = new AsyncLocalStorage<ObservabilityCell>();
let _obsCtxGlobal: ObservabilityContext | null = null;

export function getObservabilityContext(): ObservabilityContext | null {
  const cell = _obsStore.getStore();

  return cell ? cell.current : _obsCtxGlobal;
}

// Runs fn with a fresh, request-private observability cell. Save/restore call
// sites inside one request share the cell. Concurrent requests, and subagents
// that outlive their parent's pass, each get their own. `inherited` seeds the
// cell for work that outlives the request that started it.
export function runWithObservabilityScope<T>(
  fn: () => T,
  inherited: ObservabilityContext | null = null,
): T {
  return _obsStore.run({ current: inherited }, fn);
}

export function setObservabilityContext(
  ctx: ObservabilityContext | null,
): void {
  const cell = _obsStore.getStore();
  if (cell) {
    cell.current = ctx;

    return;
  }
  _obsCtxGlobal = ctx;
}

const _idGen = new RandomIdGenerator();

export function mintSpanId(): string {
  return _idGen.generateSpanId();
}

export function mintTraceId(): string {
  return _idGen.generateTraceId();
}

let _tracer: Tracer | null = null;
let _tracerProvider: BasicTracerProvider | null = null;
let _posthogTracerProvider: BasicTracerProvider | null = null;
let _loggerProvider: LoggerProvider | null = null;
// Deliberately separate from the global logger provider: only log lines added
// for PostHog below are exported to PostHog Logs.
let _posthogLoggerProvider: LoggerProvider | null = null;
let _initialized = false;

// Best-effort; `body` must already be redacted by the caller.
export function emitOtelLog(
  level: "INFO" | "WARN" | "ERROR" | "DEBUG",
  body: Record<string, unknown>,
): void {
  try {
    const ctx = getObservabilityContext();
    const logger = logs.getLogger("broods-harness");
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
      timestamp:
        typeof body.time === "string"
          ? new Date(body.time).getTime()
          : Date.now(),
    });
  } catch {
    // Best-effort: never propagate into the agent path.
  }
}

/** Flush buffered logs and spans before the request returns or the process exits. */
export async function forceFlushOtel(): Promise<void> {
  await Promise.allSettled([
    _tracerProvider?.forceFlush() ?? Promise.resolve(),
    _posthogTracerProvider?.forceFlush() ?? Promise.resolve(),
    _loggerProvider?.forceFlush() ?? Promise.resolve(),
    _posthogLoggerProvider?.forceFlush() ?? Promise.resolve(),
  ]);
}

/** Emits only purpose-written operational lines owned by the PostHog integration. */
export function emitPostHogLog(
  body: string,
  attributes: Record<string, string | number | boolean> = {},
): void {
  try {
    _posthogLoggerProvider?.getLogger("broods-posthog").emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: body,
      attributes: attributes,
    });
  } catch {
    // Best-effort: logging must never affect the serving path.
  }
}

// Returns a noop tracer if initOtel() has not run.
export function getTracer(): Tracer {
  if (_tracer) return _tracer;

  return trace.getTracer("broods-harness");
}

// Idempotent; adds PostHog AI Observability when configured, and keeps the
// optional OTLP trace/log exporters. Reads OTEL_EXPORTER_OTLP_HEADERS
// ("K=V,K2=V2", e.g. Authorization=Basic …) for the OTLP exporter.
export function initOtel(): void {
  if (_initialized) return;
  _initialized = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const rawHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const posthogProjectToken = process.env.POSTHOG_API_KEY;
  const posthogHost = process.env.POSTHOG_HOST;

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

    const resource = resourceFromAttributes({
      "service.name": process.env.SERVICE_NAME ?? "broods-core",
      "service.namespace": "beeblast",
      ...(process.env.DEPLOYMENT_ENVIRONMENT
        ? {
            "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT,
          }
        : {}),
    });
    if (!endpoint && (!posthogProjectToken || !posthogHost)) return;

    if (endpoint) {
      const tracerProvider = new BasicTracerProvider({
        resource: resource,
        spanProcessors: [
          new BatchSpanProcessor(
            new OTLPTraceExporter({
              url: `${endpoint}/v1/traces`,
              headers: headers,
              timeoutMillis: 5000,
            }),
          ),
        ],
      });
      trace.setGlobalTracerProvider(tracerProvider);
      _tracerProvider = tracerProvider;
      _tracer = trace.getTracer("broods-harness");

      const logExporter = new OTLPLogExporter({
        url: `${endpoint}/v1/logs`,
        headers: headers,
        timeoutMillis: 5000,
      });
      const loggerProvider = new LoggerProvider({
        resource: resource,
        processors: [new BatchLogRecordProcessor({ exporter: logExporter })],
      });
      logs.setGlobalLoggerProvider(loggerProvider);
      _loggerProvider = loggerProvider;
    }

    let aiTracer = _tracer;
    if (posthogProjectToken && posthogHost) {
      const aiSpanProcessors = [
        new AnonymousSpanProcessor(
          new PostHogSpanProcessor({
            projectToken: posthogProjectToken,
            host: posthogHost,
          }),
        ),
        ...(endpoint
          ? [
              new BatchSpanProcessor(
                new OTLPTraceExporter({
                  url: `${endpoint}/v1/traces`,
                  headers: headers,
                  timeoutMillis: 5000,
                }),
              ),
            ]
          : []),
      ];
      _posthogTracerProvider = new BasicTracerProvider({
        resource: resource,
        spanProcessors: aiSpanProcessors,
      });
      aiTracer = _posthogTracerProvider.getTracer("broods-ai");

      const posthogLogExporter = new OTLPLogExporter({
        url: `${posthogHost.replace(/\/+$/, "")}/i/v1/logs`,
        headers: { Authorization: `Bearer ${posthogProjectToken}` },
        timeoutMillis: 5000,
      });
      _posthogLoggerProvider = new LoggerProvider({
        resource: resource,
        processors: [
          new BatchLogRecordProcessor({ exporter: posthogLogExporter }),
        ],
      });
      emitPostHogLog("PostHog log export initialized", {
        integration: "posthog_logs",
      });
    }

    if (!aiTracer) return;

    // AI SDK v7 uses this integration to produce gen-ai spans. The session is
    // a keyed tag of the run's conversation, never the key or the requester.
    registerTelemetry(
      new OpenTelemetry({
        tracer: aiTracer,
        enrichSpan: ({ runtimeContext }) => {
          const context = getObservabilityContext();

          return {
            environment:
              typeof runtimeContext?.properties === "object" &&
              runtimeContext.properties !== null &&
              "environment" in runtimeContext.properties &&
              typeof runtimeContext.properties.environment === "string"
                ? runtimeContext.properties.environment
                : undefined,
            $ai_session_id: context
              ? analyticsSessionTag(context.conversationKey)
              : undefined,
            $ai_trace_name:
              typeof runtimeContext?.traceName === "string"
                ? runtimeContext.traceName
                : undefined,
          };
        },
      }),
    );
  } catch {
    // Best-effort: a failed init leaves the global API noop.
  }
}

/** Tenant attributes shared by logs and spans and consumed by gateway filters. */
export function observabilityAttributes(
  ctx: Pick<
    ObservabilityContext,
    | "accountId"
    | "project"
    | "stage"
    | "endpointId"
    | "agentId"
    | "conversationKey"
  >,
): Record<string, string> {
  return {
    account_id: ctx.accountId,
    project: ctx.project,
    stage: ctx.stage,
    endpoint_id: ctx.endpointId,
    agent_id: ctx.agentId,
    conversation_key: ctx.conversationKey,
  };
}

/** Wraps the PostHog processor so no user content leaves: content attributes and error text are dropped; codes and error types stay. */
export class AnonymousSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  onEnd(span: ReadableSpan): void {
    // Captured once so the copy does not keep the original span alive.
    const spanContext = span.spanContext();
    this.inner.onEnd({
      name: span.name,
      kind: span.kind,
      spanContext: () => spanContext,
      parentSpanContext: span.parentSpanContext,
      startTime: span.startTime,
      endTime: span.endTime,
      status: { code: span.status.code },
      attributes: Object.fromEntries(
        Object.entries(span.attributes).filter(
          ([key]) => !USER_CONTENT_ATTRIBUTES.has(key),
        ),
      ),
      links: span.links,
      events: span.events.map((event) => {
        if (event.name !== "exception") return event;
        const type = event.attributes?.["exception.type"];

        return {
          name: event.name,
          time: event.time,
          attributes: type === undefined ? {} : { "exception.type": type },
        };
      }),
      duration: span.duration,
      ended: span.ended,
      resource: span.resource,
      instrumentationScope: span.instrumentationScope,
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
    });
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
