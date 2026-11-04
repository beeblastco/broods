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
type ClosingAttributes = Record<string, string | number | boolean | undefined>;

export type TrackedSpan = {
  otelSpan: Span;
  otelContext: OtelContext;
  name: "model.step" | "tool.call";
  key?: TrackedSpanKey;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeMs: number;
  attributes: SpanAttributes;
};

export type TrackedSpanKey = number | string;

export interface RunSpanIdentity {
  tracer: Tracer;
  scope: Parameters<typeof observabilityAttributes>[0];
  traceId: string;
  rootSpanId: string;
  rootOtelContext: OtelContext;
  session: Pick<
    ObservabilitySpanRow,
    "endpointId" | "agentId" | "conversationKey"
  >;
  publish: (row: ObservabilitySpanRow) => Promise<void>;
}

// The OTel span always ends before its row publishes, so Tempo never trails the dashboard.
export interface RunSpanTracker {
  close: (
    tracked: TrackedSpan,
    endMs: number,
    status: "ok" | "error",
    attributes: ClosingAttributes,
    error?: string,
  ) => void;
  // `stepAttributes`: a step whose every attempt failed never reaches onStepEnd.
  closeOrphans: (
    endMs: number,
    status: "completed" | "failed",
    error: string | undefined,
    stepAttributes: (stepNumber: number) => Record<string, string | number>,
  ) => void;
  get: (key: TrackedSpanKey) => TrackedSpan | undefined;
  // A span whose start hook never ran, for `close` to end at once: never kept, no running row.
  late: (
    name: TrackedSpan["name"],
    startMs: number,
    attributes: SpanAttributes,
  ) => TrackedSpan;
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
  phase: (
    phaseName: string,
    label: string,
    startMs: number,
    endMs: number,
    extraAttributes?: Record<string, number>,
  ) => void;
  retry: (toolCallId: string, waitMs: number) => void;
}

export function createRunSpanTracker(
  identity: RunSpanIdentity,
): RunSpanTracker {
  const scopeAttributes = observabilityAttributes(identity.scope);
  const kept = new Map<TrackedSpanKey, TrackedSpan>();

  // A noop tracer hands out all-zero ids.
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
      // Tool calls (string keys) close before the steps (number keys) that parent them.
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
      } catch {}
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
