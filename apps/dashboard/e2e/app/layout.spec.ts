/**
 * The signed-in shell at a laptop viewport: header and sidebar fit with no
 * sideways scroll on every project page, with the sidebar pinned and collapsed.
 * The header once ran 127px past 1280, cutting off the last nav links and the
 * avatar and scrolling the page on every hover.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { NAV_ITEMS } from "../../app/lib/navigation";
import {
  CANVAS_READY,
  hasProbe,
  MISSING_PROBE,
  readProjectId,
} from "../lib/session";

test.skip(!hasProbe(), MISSING_PROBE);
const RAIL_WIDTH = 48;
const SIDEBAR_WIDTH = 256;

test.use({ viewport: { width: 1280, height: 800 } });

test("every project page fits 1280 wide, sidebar pinned and collapsed", async ({
  page,
}) => {
  const projectId = readProjectId();

  for (const item of NAV_ITEMS) {
    await page.goto(`/${projectId}${item.segment}`);
    await expect(
      item.segment === ""
        ? page.locator(CANVAS_READY)
        : page.getByRole("heading", { level: 1 }),
    ).toBeAttached();
    expect(await horizontalOverflow(page), item.label).toBe(0);
  }

  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(sidebarState(page)).toHaveAttribute("data-state", "collapsed");
  expect(await horizontalOverflow(page), "collapsed").toBe(0);
});

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

test("a collapsed sidebar keeps its icon rail, opens over the page on hover, and stays collapsed across a reload", async ({
  page,
}) => {
  await page.goto(`/${readProjectId()}/dashboard?tab=tracing`);
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect(container).toBeInViewport();

  await page.mouse.move(800, 400);
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebarState(page)).toHaveAttribute("data-state", "collapsed");
  await expect(container).toBeInViewport();
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: RAIL_WIDTH });

  await page.mouse.move(20, 400);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: SIDEBAR_WIDTH });
  // Drawn over the page, so nothing on it shows through the labels.
  const covering = await page.evaluate(() => {
    const hit = document.elementFromPoint(100, 300);
    return hit?.closest('[data-slot="sidebar-container"]') !== null;
  });
  expect(covering).toBe(true);
  await page.mouse.move(800, 400);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: RAIL_WIDTH });

  await page.reload();
  await expect(sidebarState(page)).toHaveAttribute("data-state", "collapsed");
});

test("on a phone the sidebar sheet closes once a link moves the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/${readProjectId()}/dashboard`);
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  const sheet = page.locator('[data-mobile="true"]');
  await sheet.getByRole("link", { name: "Scheduler" }).click();
  await expect(page).toHaveURL(/scheduler/);
  await expect(sheet).toBeHidden();
});

function sidebarState(page: Page): Locator {
  return page.locator('[data-slot="sidebar"]');
}
