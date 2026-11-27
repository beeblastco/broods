import { expect, test } from "@playwright/test";
import type { ObservabilitySpanRow } from "../../../../packages/broods/src/observability-contracts";
import { answerObservabilitySocket, NOW_MS } from "../lib/observabilitySocket";

const TRACE_ID = "a".repeat(32);

test("a live run shows its failures and retries on the row and the time axis", async ({
  page,
}) => {
  await answerObservabilitySocket(page, { traces: liveRun() });
  await page.goto(`/ui-gallery?tab=tracing&range=30d&trace=${TRACE_ID}`);

  await expect(
    page.getByText("2 tests failed: coupon applied twice"),
  ).toBeVisible();
  await expect(page.getByText("Retried 1×")).toBeVisible();
  await expect(page.getByRole("button", { name: "1 failed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "1 retried" })).toBeVisible();

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
  await expect(
    page.getByText("2 tests failed: coupon applied twice"),
  ).toHaveCount(2);
});

test("an open span sits under the trace header and folds the task list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await answerObservabilitySocket(page, { traces: liveRun() });
  await page.goto(`/ui-gallery?tab=tracing&range=30d&trace=${TRACE_ID}`);
  const list = page.locator("[data-scroll-pane]").first();
  await expect.poll(async () => (await list.boundingBox())?.width).toBe(320);

  await page.getByRole("button", { name: "1 failed" }).click();
  const detail = page.locator('[data-slot="resizable-panel"]').nth(1);
  await expect(detail).toBeVisible();
  const header = await page
    .getByRole("button", { name: "1 failed" })
    .boundingBox();
  const detailBox = await detail.boundingBox();
  expect(detailBox?.y ?? 0).toBeGreaterThanOrEqual(
    (header?.y ?? 0) + (header?.height ?? 0),
  );
  await expect.poll(async () => (await list.boundingBox())?.width).toBe(36);

  await page.getByRole("button", { name: "Show the task list" }).click();
  await expect.poll(async () => (await list.boundingBox())?.width).toBe(320);

  await page.getByRole("button", { name: "Close details" }).click();
  await expect(detail).toHaveCount(0);
});

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
