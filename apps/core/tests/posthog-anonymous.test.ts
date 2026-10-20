/**
 * PostHog gets AI Observability spans with no user content: error text is
 * stripped before export and sessions are keyed tags of the conversation key.
 */

import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { AnonymousSpanProcessor } from "../src/shared/otel.ts";
import { analyticsSessionTag } from "../src/shared/run-token.ts";

describe("PostHog anonymity", () => {
  it("strips error messages and stacks but keeps the code and error type", () => {
    const exported: ReadableSpan[] = [];
    const capture: SpanProcessor = {
      forceFlush: (): Promise<void> => Promise.resolve(),
      onEnd: (span: ReadableSpan): void => {
        exported.push(span);
      },
      onStart: (): void => {},
      shutdown: (): Promise<void> => Promise.resolve(),
    };
    const provider = new BasicTracerProvider({
      spanProcessors: [new AnonymousSpanProcessor(capture)],
    });
    const span = provider.getTracer("test").startSpan("execute_tool fill");
    span.recordException({
      name: "Error",
      message: "What is your current academic performance rating?",
      stack: "Error: What is your current academic performance rating?",
    });
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: "What is your current academic performance rating?",
    });
    span.end();

    const [sent] = exported;
    expect(sent?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(sent?.events).toHaveLength(1);
    expect(sent?.events[0]?.attributes).toEqual({ "exception.type": "Error" });
    expect(sent?.spanContext().spanId).toBe(span.spanContext().spanId);
    expect(JSON.stringify(sent)).not.toContain("academic performance");
  });

  it("tags the conversation key with the stage secret, not a plain hash", () => {
    const key = "acct:a1:agent:g1:whatsapp:+31612345678";
    const previous = process.env.STAGE_TICKET_SECRET;
    process.env.STAGE_TICKET_SECRET = "test-stage-secret";
    try {
      const tag = analyticsSessionTag(key);

      expect(analyticsSessionTag(key)).toBe(tag);
      expect(tag).toMatch(/^[0-9a-f]{64}$/);
      expect(tag).not.toBe(createHash("sha256").update(key).digest("hex"));
      process.env.STAGE_TICKET_SECRET = "another-stage-secret";
      expect(analyticsSessionTag(key)).not.toBe(tag);
    } finally {
      process.env.STAGE_TICKET_SECRET = previous;
    }
  });
});
