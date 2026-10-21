import {
  expect,
  test,
  type JSHandle,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  DETAIL_DEFAULT_WIDTH,
  TABLE_MIN_WIDTH,
} from "../../app/lib/detailSplit";
import { openGallery } from "../lib/gallery";

/** Pointer travel the handle should follow one for one. */
const DRAG = 100;

/** A drag long enough to show up as jank if the resize forces layout per move. */
const PERF_STEPS = 60;

/** Subpixel flex layout. */
const TOLERANCE_PX = 1;

type LongTask = Pick<PerformanceEntry, "startTime" | "duration">;

test("the detail column opens beside the table, follows the handle, and keeps the table's floor", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="detail-split"]');
  const group = fixture.locator('[data-slot="resizable-panel-group"]');
  const panels = group.locator('[data-slot="resizable-panel"]');
  const table = panels.first();
  // The frame the panels share: the group's box inside its own border.
  const frame = await group.evaluate((element) => element.clientWidth);

  // Closed: the table alone fills the frame.
  await expect(panels).toHaveCount(1);
  expectNear(await width(table), frame);

  await fixture.getByRole("button", { name: "Open details" }).click();
  const detail = panels.last();
  await expect(detail).toContainText("Detail body");
  const handle = group.getByRole("separator");
  const handleWidth = await width(handle);
  const detailBox = (await detail.boundingBox())!;
  const tableBox = (await table.boundingBox())!;
  expectNear(detailBox.width, DETAIL_DEFAULT_WIDTH);
  // Side by side on one row, the detail to the right of the table.
  expectNear(detailBox.y, tableBox.y);
  expectNear(detailBox.x, tableBox.x + tableBox.width + handleWidth);

  await dragHandle(page, handle, -DRAG);
  expectNear(await width(detail), DETAIL_DEFAULT_WIDTH + DRAG);
  expectNear(await width(table), tableBox.width - DRAG);

  // Dragging past the table's floor stops at the floor, and the detail takes
  // exactly the rest rather than overflowing the frame.
  await dragHandle(page, handle, -frame);
  expectNear(await width(table), TABLE_MIN_WIDTH);
  expectNear(await width(detail), frame - handleWidth - TABLE_MIN_WIDTH);

  await detail.getByRole("button", { name: "Close details" }).click();
  await expect(panels).toHaveCount(1);
  expectNear(await width(table), frame);
});

test("the handle owns the resize cursor, the group holds it through a drag, and no rule restyles the page", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="detail-split"]');
  await fixture.getByRole("button", { name: "Open details" }).click();
  const group = fixture.locator('[data-slot="resizable-panel-group"]');
  const handle = group.getByRole("separator");
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  expect(await cursor(handle)).toBe("col-resize");
  expect(await cursor(group)).toBe("auto");
  expect(await pageWideRules(page)).toBe(0);

  // Off the handle mid-drag, the group still shows the resize cursor.
  await page.mouse.down();
  await page.mouse.move(x - DRAG, y + DRAG, { steps: 5 });
  expect(await cursor(group)).toBe("col-resize");
  expect(await pageWideRules(page)).toBe(0);

  await page.mouse.up();
  expect(await cursor(group)).toBe("auto");
});

test("on a phone the open detail takes the table's place, and closing it brings the table back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openGallery(page);
  const fixture = page.locator('[data-fixture="detail-split"]');
  const table = fixture.getByRole("table");
  await expect(table).toBeVisible();

  await fixture.getByRole("button", { name: "Open details" }).click();
  await expect(fixture.getByText("Detail body")).toBeVisible();
  await expect(table).toBeHidden();
  // No side-by-side split, so no handle to drag.
  await expect(fixture.getByRole("separator")).toHaveCount(0);

  await fixture.getByRole("button", { name: "Close details" }).click();
  await expect(table).toBeVisible();
  await expect(fixture.getByText("Detail body")).toHaveCount(0);
});

test("crossing the phone width keeps the table and detail mounted", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="detail-split"]');
  const table = fixture.getByRole("table");
  await fixture.getByRole("button", { name: "Open details" }).click();
  await table.evaluate((node) => node.setAttribute("data-probe", "kept"));

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(table).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(table).toBeVisible();
  await expect(table).toHaveAttribute("data-probe", "kept");
});

test.describe("drag performance", () => {
  // A long task is anything over 50ms on the main thread. The drag itself is
  // well under that, but a runner's GC pause can land inside the window.
  test.describe.configure({ retries: 1 });

  test("a drag resizes live without long tasks and settles once released", async ({
    page,
  }) => {
    await openGallery(page);
    const fixture = page.locator('[data-fixture="detail-split"]');
    await fixture.getByRole("button", { name: "Open details" }).click();
    const group = fixture.locator('[data-slot="resizable-panel-group"]');
    const detail = group.locator('[data-slot="resizable-panel"]').last();
    const handle = group.getByRole("separator");

    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    // Releasing the handle commits the layout once; a slow runner stretches
    // that past 50ms. The press and the moves in between count; both are the
    // drag.
    const longTasks = await watchLongTasks(page);
    await page.mouse.down();
    await page.mouse.move(x - DRAG / 2, y, { steps: PERF_STEPS / 2 });
    // Halfway through the drag the panel has already moved: the resize is
    // live, not deferred to release.
    expectNear(await width(detail), DETAIL_DEFAULT_WIDTH + DRAG / 2);
    await page.mouse.move(x - DRAG, y, { steps: PERF_STEPS / 2 });
    const lastMove = await page.evaluate(() => performance.now());
    await page.mouse.up();

    // Nothing keeps repainting after release: two samples a beat apart agree.
    const settled = await width(detail);
    await page.waitForTimeout(150);
    expect(await width(detail)).toBe(settled);

    // The wait above also lets a task that ended before release reach the observer.
    const tasks = await longTasks.evaluate((read) => read());
    expect(tasks.filter((task) => task.startTime < lastMove)).toEqual([]);
  });
});

async function cursor(element: Locator): Promise<string> {
  return await element.evaluate((node) => getComputedStyle(node).cursor);
}

/** Press the handle and slide it `dx` pixels along the row. */
async function dragHandle(
  page: Page,
  handle: Locator,
  dx: number,
): Promise<void> {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

function expectNear(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOLERANCE_PX);
}

/** Rules in constructed style sheets, where the library put its `*` cursor rule. */
async function pageWideRules(page: Page): Promise<number> {
  return await page.evaluate(() =>
    document.adoptedStyleSheets.reduce(
      (count, sheet) => count + sheet.cssRules.length,
      0,
    ),
  );
}

/**
 * Record every long task from now on, its start in the page's
 * `performance.now()` time and its length. Read them back by calling the
 * returned function, which first takes the records the observer has not
 * delivered yet.
 */
async function watchLongTasks(page: Page): Promise<JSHandle<() => LongTask[]>> {
  return await page.evaluateHandle(() => {
    const tasks: LongTask[] = [];
    const record = (entries: PerformanceEntryList): void => {
      for (const entry of entries) {
        tasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    };
    const observer = new PerformanceObserver((list) => {
      record(list.getEntries());
    });
    observer.observe({ type: "longtask" });

    return (): LongTask[] => {
      record(observer.takeRecords());

      return tasks;
    };
  });
}

async function width(element: Locator): Promise<number> {
  return (await element.boundingBox())!.width;
}
