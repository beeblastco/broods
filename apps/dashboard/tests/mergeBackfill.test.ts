import { expect, test } from "bun:test";
import {
  mergeBackfill,
  type ObservabilitySpanRow,
} from "../app/hooks/useObservabilityStream";

function span(
  spanId: string,
  startTimeMs: number,
  status: ObservabilitySpanRow["status"] = "ok",
): ObservabilitySpanRow {
  return {
    traceId: "trace-1",
    spanId: spanId,
    name: "agent.task",
    kind: "task",
    startTimeMs: startTimeMs,
    endTimeMs: startTimeMs + 1_000,
    durationMs: 1_000,
    status: status,
    attributes: {},
  };
}

test("the closing piece of a traces backfill leaves the list untouched", () => {
  const prev = [span("a", 2_000), span("b", 1_000)];

  expect(mergeBackfill(prev, [])).toBe(prev);
});

test("each backfill piece merges newest-first without duplicating a span", () => {
  const first = mergeBackfill([span("live", 5_000)], [span("c", 3_000)]);
  const second = mergeBackfill(first, [span("d", 4_000), span("c", 3_000)]);

  expect(second.map((row) => row.spanId)).toEqual(["live", "d", "c"]);
});

test("a backfilled span never downgrades a finished one back to running", () => {
  const merged = mergeBackfill(
    [span("a", 1_000, "ok")],
    [span("a", 1_000, "running")],
  );

  expect(merged.map((row) => row.status)).toEqual(["ok"]);
});
