import { expect, test, type Locator, type Page } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// The widths DetailSplit.tsx opens and floors at. Kept as numbers here because
// the spec runs in Node, where the component module cannot be imported.
const DETAIL_DEFAULT_WIDTH = 360;
const TABLE_MIN_WIDTH = 320;

/** Pointer travel the handle should follow one for one. */
const DRAG = 100;

/** A drag long enough to show up as jank if the resize forces layout per move. */
const PERF_STEPS = 60;

/** Subpixel flex layout plus the group's 1px border. */
const TOLERANCE_PX = 3;

test("the detail column opens beside the table, follows the handle, and keeps the table's floor", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="detail-split"]');
  const group = fixture.locator('[data-slot="resizable-panel-group"]');
  const panels = group.locator('[data-slot="resizable-panel"]');
  const table = panels.first();
  const groupWidth = await width(group);

  // Closed: the table alone fills the frame.
  await expect(panels).toHaveCount(1);
  expectNear(await width(table), groupWidth);

  await fixture.getByRole("button", { name: "Open details" }).click();
  const detail = panels.last();
  await expect(detail).toContainText("Detail body");
  const detailBox = (await detail.boundingBox())!;
  const tableBox = (await table.boundingBox())!;
  expectNear(detailBox.width, DETAIL_DEFAULT_WIDTH);
  // Side by side on one row, the detail to the right of the table.
  expectNear(detailBox.y, tableBox.y);
  expect(detailBox.x).toBeGreaterThanOrEqual(tableBox.x + tableBox.width - 1);

  const handle = group.getByRole("separator");
  await dragHandle(page, handle, -DRAG);
  expectNear(await width(detail), DETAIL_DEFAULT_WIDTH + DRAG);
  expectNear(await width(table), tableBox.width - DRAG);

  // Dragging past the table's floor stops at the floor, and the detail takes
  // exactly the rest rather than overflowing the frame.
  await dragHandle(page, handle, -groupWidth);
  expectNear(await width(table), TABLE_MIN_WIDTH);
  expectNear(await width(detail), groupWidth - TABLE_MIN_WIDTH);

  await detail.getByRole("button", { name: "Close details" }).click();
  await expect(panels).toHaveCount(1);
  expectNear(await width(table), groupWidth);
});

test("a drag resizes live without long tasks and settles once released", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="detail-split"]');
  await fixture.getByRole("button", { name: "Open details" }).click();
  const group = fixture.locator('[data-slot="resizable-panel-group"]');
  const detail = group.locator('[data-slot="resizable-panel"]').last();
  const handle = group.getByRole("separator");
  await countLongTasks(page);

  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - DRAG / 2, y, { steps: PERF_STEPS / 2 });
  // Halfway through the drag the panel has already moved: the resize is live,
  // not deferred to release.
  expectNear(await width(detail), DETAIL_DEFAULT_WIDTH + DRAG / 2);
  await page.mouse.move(x - DRAG, y, { steps: PERF_STEPS / 2 });
  await page.mouse.up();

  expect(await longTasks(page)).toBe(0);

  // Nothing keeps repainting after release: two samples a beat apart agree.
  const settled = await width(detail);
  await page.waitForTimeout(150);
  expect(await width(detail)).toBe(settled);
});

/** Install a long-task tally on the page; read it back with `longTasks`. */
async function countLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.longTasks = "0";
    new PerformanceObserver((list) => {
      const root = document.documentElement;
      root.dataset.longTasks = String(
        Number(root.dataset.longTasks) + list.getEntries().length,
      );
    }).observe({ type: "longtask" });
  });
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

async function longTasks(page: Page): Promise<number> {
  return await page.evaluate(() =>
    Number(document.documentElement.dataset.longTasks),
  );
}

async function width(element: Locator): Promise<number> {
  return (await element.boundingBox())!.width;
}
