import { expect, test, type Page } from "@playwright/test";
import type {
  ObservabilityLogEntry,
  ObservabilitySpanRow,
} from "../../../../packages/broods/src/observability-contracts";
import { answerObservabilitySocket, NOW_MS } from "../lib/observabilitySocket";

// Tracing's first page holds 50: the target is its last row.
const TASKS = 60;
const TARGET_TASK = 50;

test.beforeEach(async ({ page }) => {
  await answerObservabilitySocket(page, {
    logs: logEntries(),
    traces: spanRows(),
  });
});

test("View trace opens Tracing on the task without sliding the page", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=monitoring");

  const targetLog = page.getByRole("cell", { name: `run ${TARGET_TASK}` });
  await targetLog.waitFor();
  await page.getByRole("textbox", { name: "Search" }).fill("run");
  await expect(page).toHaveURL(/q=run/);
  await targetLog.click();
  expect(await shiftedOutsidePanels(page)).toEqual([]);

  await page.getByRole("button", { name: "View trace" }).click();

  await expect(page).toHaveURL(
    new RegExp(`\\?tab=tracing&trace=${traceId(TARGET_TASK)}`),
  );
  expect(page.url()).not.toContain("q=");
  await expect(page.locator(`#task-${traceId(TARGET_TASK)}`)).toBeInViewport();
  expect(await shiftedOutsidePanels(page)).toEqual([]);
});

test("a Tracing link opens its search, range and task, and ignores a bad param", async ({
  page,
}) => {
  await page.goto(
    `/ui-gallery?tab=tracing&q=task&range=30d&trace=${traceId(5)}&from=abc`,
  );

  await expect(page.getByRole("textbox", { name: "Search" })).toHaveValue(
    "task",
  );
  await expect(
    page.getByRole("button", { name: "30d", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`#task-${traceId(5)}`)).toHaveAttribute(
    "aria-current",
    "true",
  );

  await page.locator(`#task-${traceId(7)}`).click();
  await expect(page).toHaveURL(new RegExp(`trace=${traceId(7)}`));
});

test("a log line the search hides drops its strip marker and panel", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=monitoring");
  const marker = page.locator("span.w-px.bg-destructive");

  await page.getByRole("cell", { name: "run 13" }).click();
  await expect(marker).toHaveCount(1);
  await expect(page.getByRole("button", { name: "View trace" })).toBeVisible();

  await page.getByRole("textbox", { name: "Search" }).fill("level:error ");
  await expect(page.getByRole("cell", { name: "run 13" })).toHaveCount(0);
  await expect(marker).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View trace" })).toHaveCount(0);
});

function logEntries(): ObservabilityLogEntry[] {
  return Array.from({ length: TASKS }, (_, index) => {
    const task = index + 1;
    // Newest, so it is the table's first row and opening it needs no scroll.
    const age = task === TARGET_TASK ? 0 : task;

    return {
      ts: NOW_MS - age * 1_000,
      level: "INFO",
      eventType: "agent.run",
      message: `run ${task}`,
      traceId: traceId(task),
      service: "core",
    };
  });
}

async function shiftedOutsidePanels(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("*")]
      .filter(
        (element) =>
          element.scrollTop > 0 &&
          !element.closest('[data-slot="resizable-panel"], [data-scroll-pane]'),
      )
      .map(
        (element) =>
          `${element.tagName} .${String(element.className)} scrollTop=${element.scrollTop} scrollHeight=${element.scrollHeight} clientHeight=${element.clientHeight}`,
      ),
  );
}

function spanRows(): ObservabilitySpanRow[] {
  return Array.from({ length: TASKS }, (_, index) => {
    const task = index + 1;
    const start = NOW_MS - task * 60_000;

    return {
      traceId: traceId(task),
      spanId: task.toString(16).padStart(16, "0"),
      name: "agent.task",
      kind: "task",
      startTimeMs: start,
      endTimeMs: start + 2_000,
      durationMs: 2_000,
      status: "ok",
      attributes: { "task.input": `task ${task}` },
    };
  });
}

function traceId(task: number): string {
  return task.toString(16).padStart(32, "0");
}
