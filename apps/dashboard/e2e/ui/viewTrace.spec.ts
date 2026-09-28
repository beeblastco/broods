import { expect, test, type Page } from "@playwright/test";
import type {
  ObservabilityLogEntry,
  ObservabilitySpanRow,
} from "../../../../packages/broods/src/observability-contracts";

/** A loaded page of tasks: more than Tracing's first page of 50 holds. */
const TASKS = 60;

/** The task View trace opens: the last row on Tracing's first page. */
const TARGET_TASK = 50;

const NOW_MS = Date.parse("2026-09-15T10:00:00Z");

test("View trace opens Tracing on the task without sliding the page", async ({
  page,
}) => {
  await answerObservabilitySocket(page);
  await page.goto("/ui-gallery?tab=monitoring");

  // The newest log belongs to the target task, so opening it needs no scroll.
  await page.getByRole("cell", { name: `run ${TARGET_TASK}` }).click();
  expect(await shiftedOutsidePanels(page)).toEqual([]);

  await page.getByRole("button", { name: "View trace" }).click();

  await expect(page).toHaveURL(/tab=tracing/);
  await expect(page.locator(`#task-${traceId(TARGET_TASK)}`)).toBeInViewport();
  // Only the list's own pane may scroll to the task. Anything else holding
  // a scroll offset is the page sliding, with empty space left below it.
  expect(await shiftedOutsidePanels(page)).toEqual([]);
});

/** Serve every observability subscription from the fixture data below. */
async function answerObservabilitySocket(page: Page): Promise<void> {
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
          entries: message.stream === "logs" ? logEntries() : spanRows(),
        }),
      );
    });
  });
}

function logEntries(): ObservabilityLogEntry[] {
  return Array.from({ length: TASKS }, (_, index) => {
    const task = index + 1;
    // The target's log is the newest line, first in the table.
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

/** Every element outside a scroll pane that holds a scroll offset. */
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

/** A W3C trace id, never the all-zero sentinel. */
function traceId(task: number): string {
  return task.toString(16).padStart(32, "0");
}
