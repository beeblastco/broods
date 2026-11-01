import { expect, test } from "@playwright/test";

const RAIL_WIDTH = 48;
const SIDEBAR_WIDTH = 256;

test.use({ viewport: { width: 1280, height: 800 } });

test("tracing fills the page beside the collapsed icon rail", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=tracing");
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect(container).toBeInViewport();
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: RAIL_WIDTH });

  const body = page.locator("[data-scroll-pane]").first().locator("..");
  const bodyBox = await body.boundingBox();
  expect(bodyBox?.x).toBe(RAIL_WIDTH);
  expect((bodyBox?.x ?? 0) + (bodyBox?.width ?? 0)).toBe(1280);
  expect((bodyBox?.y ?? 0) + (bodyBox?.height ?? 0)).toBe(800);
});

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
  // One open and close first, so React owns the rail; then slow the growing edge.
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

test("the rail opens after the page under the pointer re-rendered", async ({
  page,
}) => {
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
  // When the node under a resting pointer goes away, Chrome's next move sends pointerover
  // with no pointerout, and React builds pointerenter from pointerout.
  await page.mouse.move(800, 410);
  await page.evaluate(() => document.elementFromPoint(800, 410)?.remove());

  await page.mouse.move(20, 400);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: SIDEBAR_WIDTH });
});

test("collapsing under the pointer keeps the rail shut", async ({ page }) => {
  await page.goto("/ui-gallery?tab=monitoring");
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect(container).toBeInViewport();
  const trigger = page.locator('[data-slot="sidebar-trigger"]');
  await trigger.click();
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: SIDEBAR_WIDTH });
  const items = container.locator('[data-slot="sidebar-menu-button"]');
  const first = await items.nth(0).boundingBox();
  const second = await items.nth(1).boundingBox();
  if (!first || !second) throw new Error("The rail items have no box.");
  await page.mouse.move(20, first.y + first.height / 2);

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: RAIL_WIDTH });
  await page.mouse.move(24, second.y + second.height / 2, { steps: 4 });
  // A reopen would have rendered and started growing by the second frame.
  await container.evaluate(async (el) => {
    for (let frame = 0; frame < 2; frame++) {
      await new Promise(requestAnimationFrame);
    }
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
    "data-collapsible",
    "icon",
  );
  expect((await container.boundingBox())?.width).toBe(RAIL_WIDTH);
});

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
