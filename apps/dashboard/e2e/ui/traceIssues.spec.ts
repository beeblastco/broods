import { expect, test, type Page } from "@playwright/test";
import type { ObservabilitySpanRow } from "../../../../packages/broods/src/observability-contracts";

/** The page's frozen clock; the live run started a minute before it. */
const NOW_MS = Date.parse("2026-09-15T10:00:00Z");

const TRACE_ID = "a".repeat(32);

test("a live run shows its failures and retries on the row and the time axis", async ({
  page,
}) => {
  await answerTraceSocket(page, liveRun());
  await page.goto(`/ui-gallery?tab=tracing&range=30d&trace=${TRACE_ID}`);

  // The failed tool's error reads under its row, without opening it.
  await expect(
    page.getByText("2 tests failed: coupon applied twice"),
  ).toBeVisible();
  await expect(page.getByText("Retried 1×")).toBeVisible();
  await expect(page.getByRole("button", { name: "1 failed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "1 retried" })).toBeVisible();

  // Each issue has a marker on the axis that opens its span, even folded
  // away under its closed step.
  await page.getByRole("button", { name: "Collapse spans" }).first().click();
  await expect(
    page.getByRole("button", { name: "run_checkout_tests", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Failed: run_checkout_tests" })
    .click();
  await expect(
    page.getByRole("button", { name: "run_checkout_tests", exact: true }),
  ).toBeInViewport();
  // The side panel opens on it, its error included.
  await expect(
    page.getByText("2 tests failed: coupon applied twice"),
  ).toHaveCount(2);
});

/** Serve the trace stream from `spans`. */
async function answerTraceSocket(
  page: Page,
  spans: ObservabilitySpanRow[],
): Promise<void> {
  await page.clock.setFixedTime(NOW_MS);
  await page.routeWebSocket(/\/observability\/ws$/, (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as {
        type: string;
        stream: string;
      };
      if (message.type !== "subscribe") return;
      socket.send(JSON.stringify({ type: "ready" }));
      socket.send(
        JSON.stringify({
          type: "backfill",
          stream: message.stream,
          entries: message.stream === "traces" ? spans : [],
        }),
      );
    });
  });
}

/** A run still going: a step that retried a 429, a failed tool, a running step. */
function liveRun(): ObservabilitySpanRow[] {
  const start = NOW_MS - 60_000;
  const span = (
    spanId: string,
    fields: Partial<ObservabilitySpanRow>,
  ): ObservabilitySpanRow => ({
    traceId: TRACE_ID,
    spanId: spanId,
    parentSpanId: "0000000000000001",
    name: "model.step",
    kind: "model.step",
    startTimeMs: start,
    endTimeMs: start,
    durationMs: 0,
    status: "ok",
    attributes: {},
    ...fields,
  });

  return [
    span("0000000000000001", {
      parentSpanId: undefined,
      name: "agent.task",
      kind: "task",
      status: "running",
      attributes: { "task.input": "Launch the new pricing page" },
    }),
    span("0000000000000002", {
      startTimeMs: start + 1_000,
      endTimeMs: start + 20_000,
      durationMs: 19_000,
      attributes: {
        "agent.step_number": 0,
        "model.attempts": 2,
        "model.retry_wait_ms": 4_000,
        "model.ttft_ms": 5_000,
        "model.attempt_errors": '["429 overloaded_error"]',
      },
    }),
    span("0000000000000003", {
      parentSpanId: "0000000000000002",
      name: "tool.call",
      kind: "tool.call",
      startTimeMs: start + 20_000,
      endTimeMs: start + 28_000,
      durationMs: 8_000,
      status: "error",
      error: "2 tests failed: coupon applied twice",
      attributes: { "tool.name": "run_checkout_tests" },
    }),
    span("0000000000000004", {
      startTimeMs: start + 29_000,
      endTimeMs: start + 29_000,
      status: "running",
      attributes: { "agent.step_number": 1 },
    }),
  ];
}
