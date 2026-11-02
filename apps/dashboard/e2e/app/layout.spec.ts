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
// The server's sidebar copy can sit beside React's for a moment; only React's is hydrated.
const SIDEBAR_CONTAINER =
  '[data-slot="sidebar-container"][data-hydrated="true"]';

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

  await page.locator(SIDEBAR_CONTAINER).waitFor();
  await page.getByRole("button", { name: "Toggle sidebar" }).click();
  await expect(sidebarState(page)).toHaveAttribute("data-state", "collapsed");
  expect(await horizontalOverflow(page), "collapsed").toBe(0);
});

for (const viewport of [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
]) {
  test(`every project page fits ${viewport.width} wide`, async ({ page }) => {
    await page.setViewportSize(viewport);
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
  });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

test("a collapsed sidebar keeps its icon rail, opens over the page on hover, and stays collapsed across a reload @post-rollout", async ({
  page,
}) => {
  await page.goto(`/${readProjectId()}/dashboard?tab=tracing`);
  const container = page.locator(SIDEBAR_CONTAINER);
  await expect(container).toBeInViewport();

  await page.mouse.move(800, 400);
  const link = container.getByRole("link").first();
  await link.focus();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebarState(page)).toHaveAttribute("data-state", "collapsed");
  await expect(container).toBeInViewport();
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: RAIL_WIDTH });
  await expect(container).not.toHaveAttribute("inert");
  await expect(link).toBeFocused();

  await page.mouse.move(20, 400);
  await expect
    .poll(() => container.boundingBox())
    .toMatchObject({ width: SIDEBAR_WIDTH });
  await expect.poll(() => pointsCoveringSidebar(page)).toEqual([]);
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

async function pointsCoveringSidebar(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const container = document.querySelector(selector);
    if (!container) throw new Error("no sidebar container");
    const rect = container.getBoundingClientRect();
    const covered: string[] = [];
    for (let y = rect.top + 4; y < rect.bottom; y += 16) {
      for (let x = rect.left + 4; x < rect.right; x += 16) {
        const hit = document.elementFromPoint(x, y);
        // The `next dev` badge does not count: builds do not render it.
        if (hit?.tagName === "NEXTJS-PORTAL") continue;
        if (!hit || !container.contains(hit)) {
          covered.push(`${Math.round(x)},${Math.round(y)}`);
        }
      }
    }

    return covered;
  }, SIDEBAR_CONTAINER);
}

function sidebarState(page: Page): Locator {
  return page.locator('[data-slot="sidebar"]', {
    has: page.locator(SIDEBAR_CONTAINER),
  });
}
