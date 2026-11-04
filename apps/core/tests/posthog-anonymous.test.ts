import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  AnonymousSpanProcessor,
  analyticsSessionTag,
} from "../src/shared/otel.ts";

describe("PostHog anonymity", () => {
  it("keeps only listed attributes and drops error text, keeping codes and types", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [
        new AnonymousSpanProcessor(new SimpleSpanProcessor(exporter)),
      ],
    });
    const span = provider.getTracer("test").startSpan("execute_tool fill");
    span.setAttributes({
      "gen_ai.tool.name": "fill",
      "ai.usage.inputTokens": 12,
      "ai.toolCall.args": '{"answer":"my home address"}',
      "gen_ai.input.messages": "my home address",
    });
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

    const [sent] = exporter.getFinishedSpans();
    expect(sent?.attributes).toEqual({
      "gen_ai.tool.name": "fill",
      "ai.usage.inputTokens": 12,
    });
    expect(sent?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(sent?.events).toHaveLength(1);
    expect(sent?.events[0]?.attributes).toEqual({ "exception.type": "Error" });
    expect(sent?.spanContext().spanId).toBe(span.spanContext().spanId);
    expect(JSON.stringify(sent)).not.toContain("academic performance");
    expect(JSON.stringify(sent)).not.toContain("home address");
  });

  it("tags the conversation key with the analytics secret, not a plain hash", () => {
    const key = "acct:a1:agent:g1:whatsapp:+31612345678";
    const previous = process.env.ANALYTICS_ID_SECRET;
    process.env.ANALYTICS_ID_SECRET = "analytics-secret";
    try {
      const tag = analyticsSessionTag(key);

      expect(analyticsSessionTag(key)).toBe(tag);
      expect(tag).toMatch(/^[0-9a-f]{64}$/);
      expect(tag).not.toBe(createHash("sha256").update(key).digest("hex"));
      process.env.ANALYTICS_ID_SECRET = "another-secret";
      expect(analyticsSessionTag(key)).not.toBe(tag);
      delete process.env.ANALYTICS_ID_SECRET;
      expect(analyticsSessionTag(key)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ANALYTICS_ID_SECRET;
      else process.env.ANALYTICS_ID_SECRET = previous;
    }
  });
});
