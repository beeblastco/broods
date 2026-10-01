import { expect, test } from "@playwright/test";

const RAIL_WIDTH = 48;
const SIDEBAR_WIDTH = 256;

test.use({ viewport: { width: 1280, height: 800 } });

// Tracing fills the page beside the collapsed rail, edge to edge with no card
// frame around it.
test("tracing fills the page beside the collapsed icon rail", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=tracing");
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect(container).toBeInViewport();
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: RAIL_WIDTH });

  const split = page.locator('[data-slot="resizable-panel-group"]');
  const splitBox = await split.boundingBox();
  expect(splitBox?.x).toBe(RAIL_WIDTH);
  expect((splitBox?.x ?? 0) + (splitBox?.width ?? 0)).toBe(1280);
  expect((splitBox?.y ?? 0) + (splitBox?.height ?? 0)).toBe(800);
});

// The open rail once let the toolbar's search icon and the sticky table head
// paint over its labels: both sit at z-10 later in the page.
test("the rail opens over the page on hover, nothing showing through", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=monitoring");
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect(container).toBeInViewport();
  const search = page.locator("svg.lucide-search").first();
  await expect(search).toBeVisible();
  const searchIcon = await search.boundingBox();
  if (!searchIcon) throw new Error("The search icon has no box.");

  await page.mouse.move(20, 400);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({
      width: SIDEBAR_WIDTH,
    });
  for (const [x, y] of [
    [searchIcon.x + searchIcon.width / 2, searchIcon.y + searchIcon.height / 2],
    // The sticky table head, just under the toolbar.
    [100, searchIcon.y + 45],
  ]) {
    const covered = await page.evaluate(
      ([px, py]) =>
        Boolean(
          document
            .elementFromPoint(px, py)
            ?.closest('[data-slot="sidebar-container"]'),
        ),
      [x, y],
    );
    expect(covered, `${x},${y}`).toBe(true);
  }

  await page.mouse.move(800, 400);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: RAIL_WIDTH });
});

// The rail grows open over 200ms, and a pointer that outran the growing edge
// once counted as leaving and closed it. One open and close first, so React
// owns the rail; then a slowed transition keeps the second move inside it.
test("a fast move into the opening rail keeps it open", async ({ page }) => {
  await page.goto("/ui-gallery?tab=monitoring");
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect(container).toBeInViewport();
  await page.mouse.move(20, 400);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: SIDEBAR_WIDTH });
  await page.mouse.move(800, 400);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: RAIL_WIDTH });
  await page.addStyleTag({
    content:
      '[data-slot="sidebar-container"] { transition-duration: 1000ms !important; }',
  });

  await page.mouse.move(20, 400);
  await page.mouse.move(200, 400);
  expect((await container.boundingBox())?.width).toBeLessThan(SIDEBAR_WIDTH);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: SIDEBAR_WIDTH });
});

// A pointer that left the window straight from the open rail sent no further
// move, so nothing closed it.
test("leaving the window from the open rail closes it", async ({ page }) => {
  await page.goto("/ui-gallery?tab=monitoring");
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect(container).toBeInViewport();
  await page.mouse.move(20, 400);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: SIDEBAR_WIDTH });

  await page.mouse.move(-10, 400);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: RAIL_WIDTH });
});

// A tap fires pointerenter but no pointer ever moves away, so a peek opened by
// touch stayed over the page.
test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } });

  test("a tap on the rail leaves it closed", async ({ page }) => {
    await page.goto("/ui-gallery?tab=monitoring");
    const container = page.locator('[data-slot="sidebar-container"]');
    await expect(container).toBeInViewport();

    await page.touchscreen.tap(20, 120);
    await page.touchscreen.tap(700, 400);
    await expect
      .poll(() => container.boundingBox())
      .toMatchObject({ width: RAIL_WIDTH });
  });
});
