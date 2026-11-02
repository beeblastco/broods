/**
 * One run's child spans under its root: model.step, tool.call and phase. Each
 * is an OTel span for Tempo and a live NATS row for the dashboard trace stream
 * that reuses the OTel ids. runAgentLoop mints the root and the trace identity
 * and feeds this from the stream callbacks; the exporters and the request
 * context both handlers share stay in shared/otel.ts.
 */

import {
  trace as otelTraceApi,
  SpanStatusCode,
  type Context as OtelContext,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { ObservabilitySpanRow } from "../../../../packages/broods/src/observability-contracts.ts";
import { mintSpanId, observabilityAttributes } from "../shared/otel.ts";

type SpanAttributes = Record<string, string | number | boolean>;
/** What a close adds to a span; a conditional spread may type a key as undefined. */
type ClosingAttributes = Record<string, string | number | boolean | undefined>;

/** An open model.step or tool.call span plus the ids its live NATS rows reuse. */
export type TrackedSpan = {
  otelSpan: Span;
  otelContext: OtelContext;
  name: "model.step" | "tool.call";
  /** What `open` kept it under; a late span has none. */
  key?: TrackedSpanKey;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeMs: number;
  attributes: SpanAttributes;
};

/** A model.step is keyed by its step number, a tool.call by its call id. */
export type TrackedSpanKey = number | string;

/** The trace one run's spans land on; nothing in it changes during the run. */
export interface RunSpanIdentity {
  tracer: Tracer;
  scope: Parameters<typeof observabilityAttributes>[0];
  /** The root's ids and context: parents for every span, and the fallback when a noop tracer hands out zero ids. */
  traceId: string;
  rootSpanId: string;
  rootOtelContext: OtelContext;
  /** The session fields every row carries. */
  session: Pick<
    ObservabilitySpanRow,
    "endpointId" | "agentId" | "conversationKey"
  >;
  /** Publishes one row to the live trace stream; best-effort, never awaited here. */
  publish: (row: ObservabilitySpanRow) => Promise<void>;
}

/**
 * One run's open spans. The OTel span always ends before its row publishes,
 * so Tempo never trails the dashboard.
 */
export interface RunSpanTracker {
  /**
   * Ends the span and publishes its closed row with `attributes` laid over the
   * ones it opened with. A failed span records `error` as its exception; a
   * tool.call also gets its duration and success stamped on the OTel span.
   */
  close: (
    tracked: TrackedSpan,
    endMs: number,
    status: "ok" | "error",
    attributes: ClosingAttributes,
    error?: string,
  ) => void;
  /**
   * Finalize: ends every span still open at `endMs` with the run's status,
   * tool calls first. `stepAttributes` adds a step's attempt attributes, since
   * a step whose every attempt failed never reaches onStepEnd.
   */
  closeOrphans: (
    endMs: number,
    status: "completed" | "failed",
    error: string | undefined,
    stepAttributes: (stepNumber: number) => Record<string, string | number>,
  ) => void;
  /** The open span kept under `key`, if any. */
  get: (key: TrackedSpanKey) => TrackedSpan | undefined;
  /**
   * A span whose start hook never ran: opened under the root for `close` to
   * end at once, so it is never kept and no running row goes out.
   */
  late: (
    name: TrackedSpan["name"],
    startMs: number,
    attributes: SpanAttributes,
  ) => TrackedSpan;
  /**
   * Opens a span under `parent` (the root when undefined), publishes its
   * running row and keeps it under `key` until `close` or `closeOrphans`.
   * A model.step is keyed by its step number, a tool.call by its call id.
   */
  open: ((
    name: "model.step",
    key: number,
    startMs: number,
    parent: TrackedSpan | undefined,
    attributes: SpanAttributes,
  ) => TrackedSpan) &
    ((
      name: "tool.call",
      key: string,
      startMs: number,
      parent: TrackedSpan | undefined,
      attributes: SpanAttributes,
    ) => TrackedSpan);
  /**
   * Emits a closed phase span under the root for work outside the model steps
   * (cold start, context prepare, compaction), so a slow turn can be
   * attributed. A phase that calls the model, like compaction, carries its
   * `model.*` tokens. Best-effort.
   */
  phase: (
    phaseName: string,
    label: string,
    startMs: number,
    endMs: number,
    extraAttributes?: Record<string, number>,
  ) => void;
  /** Passed to the tool registry as `onToolRetry`; tallies each wait on the call's open span. */
  retry: (toolCallId: string, waitMs: number) => void;
}

/** Built once per run by runAgentLoop after it mints the root span; the stream callbacks and finalize drive it. */
export function createRunSpanTracker(
  identity: RunSpanIdentity,
): RunSpanTracker {
  const scopeAttributes = observabilityAttributes(identity.scope);
  // Child OTel spans remain open until the corresponding AI SDK finish hook.
  // Their real OTel IDs are reused in the live NATS trace rows.
  const kept = new Map<TrackedSpanKey, TrackedSpan>();

  /** The ids a span's rows carry: its OTel ones, or the root trace and a minted span id under a noop tracer. */
  const rowIds = (span: Span): { traceId: string; spanId: string } => {
    const spanContext = span.spanContext();

    return {
      traceId: /[^0]/.test(spanContext.traceId)
        ? spanContext.traceId
        : identity.traceId,
      spanId: /[^0]/.test(spanContext.spanId)
        ? spanContext.spanId
        : mintSpanId(),
    };
  };

  /** Opens a model.step or tool.call OTel span and keeps the ids its live NATS row reuses. */
  const start = (
    name: TrackedSpan["name"],
    startTimeMs: number,
    parentContext: OtelContext,
    parentSpanId: string,
    attributes: SpanAttributes,
  ): TrackedSpan => {
    const otelSpan = identity.tracer.startSpan(
      name,
      {
        startTime: startTimeMs,
        attributes: { ...scopeAttributes, ...attributes },
      },
      parentContext,
    );

    return {
      otelSpan: otelSpan,
      otelContext: otelTraceApi.setSpan(parentContext, otelSpan),
      name: name,
      ...rowIds(otelSpan),
      parentSpanId: parentSpanId,
      startTimeMs: startTimeMs,
      attributes: attributes,
    };
  };

  return {
    close: (tracked, endMs, status, attributes, error): void => {
      const durationMs = endMs - tracked.startTimeMs;
      const closed = { ...tracked.attributes, ...attributes };
      tracked.otelSpan.setAttributes(
        tracked.name === "tool.call"
          ? {
              "tool.duration_ms": durationMs,
              "tool.success": status === "ok",
              ...closed,
            }
          : closed,
      );
      if (status === "ok") {
        tracked.otelSpan.setStatus({ code: SpanStatusCode.OK });
      } else {
        tracked.otelSpan.recordException(new Error(error));
        tracked.otelSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: error,
        });
      }
      tracked.otelSpan.end(endMs);
      void identity.publish({
        traceId: tracked.traceId,
        spanId: tracked.spanId,
        parentSpanId: tracked.parentSpanId,
        name: tracked.name,
        kind: tracked.name,
        startTimeMs: tracked.startTimeMs,
        endTimeMs: endMs,
        durationMs: durationMs,
        status: status,
        endpointId: identity.session.endpointId,
        agentId: identity.session.agentId,
        conversationKey: identity.session.conversationKey,
        attributes: closed,
        ...(error ? { error: error } : {}),
      });
      if (tracked.key !== undefined) kept.delete(tracked.key);
    },
    closeOrphans: (endMs, status, error, stepAttributes): void => {
      // Tool calls close before the steps that parent them.
      const orphans = [...kept.entries()].sort(
        ([a], [b]) =>
          Number(typeof a === "number") - Number(typeof b === "number"),
      );
      for (const [key, tracked] of orphans) {
        const extraAttributes =
          typeof key === "number" ? stepAttributes(key) : undefined;
        if (status === "failed") {
          tracked.otelSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: error,
          });
        }
        if (extraAttributes) tracked.otelSpan.setAttributes(extraAttributes);
        tracked.otelSpan.end(endMs);
        void identity.publish({
          traceId: tracked.traceId,
          spanId: tracked.spanId,
          parentSpanId: tracked.parentSpanId,
          name: tracked.name,
          kind: tracked.name,
          startTimeMs: tracked.startTimeMs,
          endTimeMs: endMs,
          durationMs: Math.max(0, endMs - tracked.startTimeMs),
          status: status === "completed" ? "ok" : "error",
          endpointId: identity.session.endpointId,
          agentId: identity.session.agentId,
          conversationKey: identity.session.conversationKey,
          attributes: {
            ...tracked.attributes,
            ...extraAttributes,
            [typeof key === "number" ? "step.state" : "tool.state"]: status,
          },
          ...(error !== undefined ? { error: error } : {}),
        });
      }
      kept.clear();
    },
    get: (key): TrackedSpan | undefined => kept.get(key),
    late: (name, startMs, attributes): TrackedSpan =>
      start(
        name,
        startMs,
        identity.rootOtelContext,
        identity.rootSpanId,
        attributes,
      ),
    open: (
      name: TrackedSpan["name"],
      key: TrackedSpanKey,
      startMs: number,
      parent: TrackedSpan | undefined,
      attributes: SpanAttributes,
    ): TrackedSpan => {
      const tracked = {
        ...start(
          name,
          startMs,
          parent?.otelContext ?? identity.rootOtelContext,
          parent?.spanId ?? identity.rootSpanId,
          attributes,
        ),
        key: key,
      };
      kept.set(key, tracked);
      void identity.publish({
        traceId: tracked.traceId,
        spanId: tracked.spanId,
        parentSpanId: tracked.parentSpanId,
        name: name,
        kind: name,
        startTimeMs: startMs,
        endTimeMs: startMs,
        durationMs: 0,
        status: "running",
        endpointId: identity.session.endpointId,
        agentId: identity.session.agentId,
        conversationKey: identity.session.conversationKey,
        attributes: attributes,
      });

      return tracked;
    },
    phase: (phaseName, label, startMs, endMs, extraAttributes = {}): void => {
      try {
        const durationMs = Math.max(0, endMs - startMs);
        const attributes = {
          "phase.name": label,
          "phase.duration_ms": durationMs,
          ...extraAttributes,
        };
        const phaseSpan = identity.tracer.startSpan(
          phaseName,
          {
            startTime: startMs,
            attributes: { ...scopeAttributes, ...attributes },
          },
          identity.rootOtelContext,
        );
        phaseSpan.end(endMs);
        void identity.publish({
          ...rowIds(phaseSpan),
          parentSpanId: identity.rootSpanId,
          name: phaseName,
          kind: "phase",
          startTimeMs: startMs,
          endTimeMs: endMs,
          durationMs: durationMs,
          status: "ok",
          endpointId: identity.session.endpointId,
          agentId: identity.session.agentId,
          conversationKey: identity.session.conversationKey,
          attributes: attributes,
        });
      } catch {
        // Best-effort: a telemetry failure must not affect the run.
      }
    },
    retry: (toolCallId, waitMs): void => {
      const tracked = kept.get(toolCallId);
      if (!tracked) return;
      const retry = {
        "tool.retry.count":
          Number(tracked.attributes["tool.retry.count"] ?? 0) + 1,
        "tool.retry.wait_ms":
          Number(tracked.attributes["tool.retry.wait_ms"] ?? 0) + waitMs,
      };
      // A fresh object: the running row published at start may still hold the old one.
      tracked.attributes = { ...tracked.attributes, ...retry };
      tracked.otelSpan.setAttributes(retry);
    },
  };
}
