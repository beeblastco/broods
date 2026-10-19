/**
 * The run's step timing tracker: how one model.step splits into ttft,
 * streaming and tool wait, the per-kind streaming windows, and the attempt
 * attributes a retried stream start leaves on the span.
 */

import { describe, expect, it } from "bun:test";
import { createStepTimingTracker } from "../src/harness/usage-metering.ts";

const serialize = (value: unknown): string => JSON.stringify(value);

describe("createStepTimingTracker", () => {
  it("splits a step into ttft, streaming and tool wait that sum to its duration", () => {
    const tracker = createStepTimingTracker(serialize);
    tracker.startStep(0, 1_000);
    tracker.recordChunk("text-delta", 1_250);
    tracker.recordChunk("text-delta", 1_400);
    tracker.recordChunk("tool-call", 1_600);

    const attributes = tracker.closeStep(0, 2_100);

    expect(attributes).toEqual({
      "model.ttft_ms": 250,
      "model.stream_ms": 350,
      "model.tool_wait_ms": 500,
      "model.text_stream_ms": 150,
      "model.tool_input_stream_ms": 0,
    });
    expect(
      Number(attributes["model.ttft_ms"]) +
        Number(attributes["model.stream_ms"]) +
        Number(attributes["model.tool_wait_ms"]),
    ).toBe(2_100 - 1_000);
  });

  it("never lets a tool result extend the streaming window", () => {
    const tracker = createStepTimingTracker(serialize);
    tracker.startStep(0, 1_000);
    tracker.recordChunk("tool-input-start", 1_100);
    tracker.recordChunk("tool-call", 1_200);
    // The tracker is the only filter: a slow tool is wait, not generation.
    tracker.recordChunk("tool-result", 4_000);
    tracker.recordChunk("finish-step", 4_050);

    expect(tracker.closeStep(0, 4_100)).toEqual({
      "model.ttft_ms": 100,
      "model.stream_ms": 100,
      "model.tool_wait_ms": 2_900,
      "model.tool_input_stream_ms": 100,
    });
  });

  it("attributes interleaved reasoning and text to separate windows", () => {
    const tracker = createStepTimingTracker(serialize);
    tracker.startStep(2, 0);
    tracker.recordChunk("reasoning-delta", 100);
    tracker.recordChunk("text-delta", 200);
    tracker.recordChunk("reasoning-delta", 300);
    tracker.recordChunk("text-delta", 500);

    expect(tracker.closeStep(2, 600)).toEqual({
      "model.ttft_ms": 100,
      "model.stream_ms": 400,
      "model.tool_wait_ms": 100,
      "model.reasoning_stream_ms": 200,
      "model.text_stream_ms": 300,
    });
  });

  it("drops chunks that arrive with no active step", () => {
    const tracker = createStepTimingTracker(serialize);
    tracker.recordChunk("text-delta", 100);
    tracker.startStep(0, 1_000);

    expect(tracker.closeStep(0, 1_500)).toEqual({});
  });

  it("reports one attempt as model.attempts only", () => {
    const tracker = createStepTimingTracker(serialize);
    tracker.startStep(0, 1_000);
    tracker.recordAttempt({ startedAt: 1_000 });

    expect(tracker.attemptAttributes(0)).toEqual({
      "model.attempts": 1,
    });
  });

  it("reports the retry wait and the errors of a retried stream start", () => {
    const tracker = createStepTimingTracker(serialize);
    tracker.startStep(0, 1_000);
    tracker.recordAttempt({ startedAt: 1_000, error: "429 rate limited" });
    tracker.recordAttempt({ startedAt: 3_000 });
    tracker.recordChunk("text-delta", 3_400);

    expect(tracker.closeStep(0, 3_500)).toEqual({
      "model.ttft_ms": 2_400,
      "model.attempts": 2,
      "model.retry_wait_ms": 2_000,
      "model.attempt_errors": serialize(["429 rate limited"]),
      "model.stream_ms": 0,
      "model.tool_wait_ms": 100,
      "model.text_stream_ms": 0,
    });
  });

  it("keeps attributes for a step whose every attempt failed", () => {
    const tracker = createStepTimingTracker(serialize);
    tracker.startStep(1, 1_000);
    tracker.recordAttempt({ startedAt: 1_000, error: "503" });
    tracker.recordAttempt({ startedAt: 2_000, error: "503" });

    expect(tracker.attemptAttributes(1)).toEqual({
      "model.attempts": 2,
      "model.retry_wait_ms": 1_000,
      "model.attempt_errors": serialize(["503", "503"]),
    });
  });

  it("files an attempt recorded with no active step on the next step that starts", () => {
    const tracker = createStepTimingTracker(serialize);
    tracker.startStep(0, 1_000);
    tracker.closeStep(0, 1_500);
    tracker.endActiveStep(0);
    tracker.recordAttempt({ startedAt: 1_600, error: "503 overloaded" });
    tracker.startStep(1, 2_000);
    tracker.recordAttempt({ startedAt: 2_000 });

    expect(tracker.attemptAttributes(0)).toEqual({});
    expect(tracker.closeStep(1, 2_500)).toEqual({
      "model.attempts": 2,
      "model.retry_wait_ms": 0,
      "model.attempt_errors": serialize(["503 overloaded"]),
    });
  });

  it("clear logs the error of an attempt no step took", () => {
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      lines.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );

      return true;
    }) as typeof process.stdout.write;
    try {
      const tracker = createStepTimingTracker(serialize);
      tracker.recordAttempt({ startedAt: 500, error: "503 overloaded" });
      tracker.clear();
      tracker.clear();
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "WARN",
      attempts: 1,
      attemptErrors: serialize(["503 overloaded"]),
    });
  });

  it("closeStep clears that step's state and leaves other steps alone", () => {
    const tracker = createStepTimingTracker(serialize);
    tracker.startStep(0, 1_000);
    tracker.recordChunk("text-delta", 1_100);
    tracker.recordAttempt({ startedAt: 1_000 });
    tracker.startStep(1, 2_000);
    tracker.recordChunk("text-delta", 2_300);

    expect(tracker.closeStep(0, 1_900)).toEqual({
      "model.ttft_ms": 100,
      "model.attempts": 1,
      "model.stream_ms": 0,
      "model.tool_wait_ms": 800,
      "model.text_stream_ms": 0,
    });
    expect(tracker.stepStartMs(0)).toBeUndefined();
    expect(tracker.closeStep(0, 1_900)).toEqual({});
    expect(tracker.attemptAttributes(0)).toEqual({});

    expect(tracker.stepStartMs(1)).toBe(2_000);
    expect(tracker.closeStep(1, 2_500)).toEqual({
      "model.ttft_ms": 300,
      "model.stream_ms": 0,
      "model.tool_wait_ms": 200,
      "model.text_stream_ms": 0,
    });
  });

  it("tracks the active step across start, end and a newer step taking over", () => {
    const tracker = createStepTimingTracker(serialize);
    expect(tracker.activeStep()).toBeUndefined();
    tracker.startStep(0, 1_000);
    expect(tracker.activeStep()).toBe(0);
    tracker.startStep(1, 2_000);
    // Ending the older step must not drop the newer one that took over.
    tracker.endActiveStep(0);
    expect(tracker.activeStep()).toBe(1);
    tracker.endActiveStep(1);
    expect(tracker.activeStep()).toBeUndefined();
  });

  it("clear drops every step", () => {
    const tracker = createStepTimingTracker(serialize);
    tracker.startStep(0, 1_000);
    tracker.recordChunk("text-delta", 1_100);
    tracker.recordAttempt({ startedAt: 1_000 });
    tracker.clear();

    expect(tracker.activeStep()).toBeUndefined();
    expect(tracker.stepStartMs(0)).toBeUndefined();
    expect(tracker.closeStep(0, 2_000)).toEqual({});
  });
});
