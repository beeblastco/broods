/**
 * The signed-in shell at a laptop viewport: header and sidebar fit with no
 * sideways scroll on every project page, with the sidebar pinned and hidden.
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
test.use({ viewport: { width: 1280, height: 800 } });

test("every project page fits 1280 wide, sidebar pinned and hidden", async ({
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
  expect(await horizontalOverflow(page), "hidden").toBe(0);
});

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

test("a hidden sidebar peeks at the left edge and stays hidden across a reload", async ({
  page,
}) => {
  await page.goto(`/${readProjectId()}/dashboard`);
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect(container).toBeInViewport();

  // Off the edge first: the pointer starts at 0,0, where a hidden sidebar peeks.
  await page.mouse.move(800, 400);
  const toggle = page.getByRole("button", { name: "Toggle sidebar" });
  const link = container.getByRole("link").first();
  // Hiding with focus inside hands it to the toggle, not to the page, and
  // takes the hidden links out of the tab order.
  await link.focus();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebarState(page)).toHaveAttribute("data-state", "collapsed");
  await expect(container).not.toBeInViewport();
  await expect(container).toHaveAttribute("inert", "");
  await expect(toggle).toBeFocused();

  await page.mouse.move(4, 400);
  await expect(container).toBeInViewport();
  // The log table's sticky header and the search icon once painted over it.
  await expect.poll(() => pointsCoveringSidebar(page)).toEqual([]);
  // A peek is the real sidebar, links and all.
  await link.focus();
  await expect(link).toBeFocused();
  // Moving along the edge, where the reveal strip was, keeps it up.
  await page.mouse.move(8, 440);
  await expect(container).toBeInViewport();
  // A peek ending hands focus back to the toggle too.
  await page.mouse.move(800, 400);
  await expect(container).not.toBeInViewport();
  await expect(toggle).toBeFocused();

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

// Points on a 16px grid over the sidebar where something other than the
// sidebar is the topmost element, as "x,y". The `next dev` badge in the
// corner does not count: builds do not render it.
async function pointsCoveringSidebar(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const container = document.querySelector('[data-slot="sidebar-container"]');
    if (!container) throw new Error("no sidebar container");
    const rect = container.getBoundingClientRect();
    const covered: string[] = [];
    for (let y = rect.top + 4; y < rect.bottom; y += 16) {
      for (let x = rect.left + 4; x < rect.right; x += 16) {
        const hit = document.elementFromPoint(x, y);
        if (hit?.tagName === "NEXTJS-PORTAL") continue;
        if (!hit || !container.contains(hit)) {
          covered.push(`${Math.round(x)},${Math.round(y)}`);
        }
      }
    }

    return covered;
  });
}

function sidebarState(page: Page): Locator {
  return page.locator('[data-slot="sidebar"]');
}
