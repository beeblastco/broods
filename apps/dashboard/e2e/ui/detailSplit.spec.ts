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

const DRAG = 100;

const PERF_STEPS = 60;

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
  const frame = await group.evaluate((element) => element.clientWidth);

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
  expectNear(detailBox.y, tableBox.y);
  expectNear(detailBox.x, tableBox.x + tableBox.width + handleWidth);

  await dragHandle(page, handle, -DRAG);
  expectNear(await width(detail), DETAIL_DEFAULT_WIDTH + DRAG);
  expectNear(await width(table), tableBox.width - DRAG);

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

  const offLine = await page.evaluate(
    ([px, py]) => getComputedStyle(document.elementFromPoint(px, py)!).cursor,
    [x + 4, y],
  );
  expect(offLine).toBe("col-resize");
  await page.mouse.move(x, y);
  // The resize library's `*` cursor rule would reach the group and the body.
  await expect(group).toHaveCSS("cursor", "auto");
  const body = page.locator("body");
  await expect(body).toHaveCSS("cursor", "auto");

  const close = group.getByRole("button", { name: "Close details" });
  await expect(close).toHaveCSS("cursor", "pointer");
  await page.mouse.down();
  await page.mouse.move(x - DRAG, y + DRAG, { steps: 5 });
  await expect(group).toHaveCSS("cursor", "col-resize");
  await expect(close).toHaveCSS("cursor", "col-resize");
  await expect(body).toHaveCSS("cursor", "auto");

  await page.mouse.up();
  await expect(group).toHaveCSS("cursor", "auto");
  await expect(close).toHaveCSS("cursor", "pointer");
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
  // A runner's GC pause can land a >50ms long task inside the window.
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
    // Release commits the layout once, past 50ms on a slow runner: only the drag counts.
    const longTasks = await watchLongTasks(page);
    await page.mouse.down();
    await page.mouse.move(x - DRAG / 2, y, { steps: PERF_STEPS / 2 });
    expectNear(await width(detail), DETAIL_DEFAULT_WIDTH + DRAG / 2);
    await page.mouse.move(x - DRAG, y, { steps: PERF_STEPS / 2 });
    const lastMove = await page.evaluate(() => performance.now());
    await page.mouse.up();

    const settled = await width(detail);
    await page.waitForTimeout(150);
    expect(await width(detail)).toBe(settled);

    // The wait above also lets a task ended before release reach the observer.
    const tasks = await longTasks.evaluate((read) => read());
    expect(tasks.filter((task) => task.startTime < lastMove)).toEqual([]);
  });
});

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
