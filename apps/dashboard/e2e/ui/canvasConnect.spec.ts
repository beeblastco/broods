import { expect, test, type Locator, type Page } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// React Flow reads the connection off mousemove: one jump never picks a drop target.
const DRAG_STEPS = 12;

test("an agent's edge lands on a card or a chip dropped anywhere on it", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-connect"]');
  await fixture.scrollIntoViewIfNeeded();
  const log = fixture.locator('[data-testid="connect-log"]');
  await expect(log).toHaveText(
    "xy-edge__alpha-box-one | xy-edge__alpha-box-two",
  );

  await dragFromAgent(page, fixture, "beta", "fresh-box");
  await expect(log).toContainText("xy-edge__beta-fresh-boxtop");

  await dragFromAgent(page, fixture, "beta", "box-one");
  await expect(log).toContainText("xy-edge__beta-box-onetop");
});

test("a refused connection says why, while aimed and after the drop", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-connect"]');
  await fixture.scrollIntoViewIfNeeded();
  const notice = fixture.locator('[data-slot="canvas-notice"]');
  const outline = fixture.locator('[data-slot="canvas-refused-outline"]');

  await aimFromAgent(page, fixture, "alpha", "box-one");
  await expect(notice).toContainText("alpha is already connected to box-one.");
  await expect(notice).toContainText("Release to cancel");
  const chip = await fixture
    .locator('.react-flow__node[data-id="box-one"]')
    .boundingBox();
  const box = await outline.boundingBox();
  expect(Math.abs((box?.x ?? 0) - (chip?.x ?? -9))).toBeLessThan(1.5);
  expect(Math.abs((box?.width ?? 0) - (chip?.width ?? -9))).toBeLessThan(1.5);

  await page.mouse.up();
  await expect(notice).toContainText("alpha is already connected to box-one.");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
});

test("the refusal notice stays inside a narrow canvas", async ({ page }) => {
  await page.setViewportSize({ height: 800, width: 340 });
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-connect"]');
  await fixture.scrollIntoViewIfNeeded();

  await aimFromAgent(page, fixture, "alpha", "box-one");
  const notice = await fixture
    .locator('[data-slot="canvas-notice"]')
    .boundingBox();
  const canvas = await fixture.locator(".react-flow").boundingBox();
  await page.mouse.up();

  expect(notice?.x ?? -1).toBeGreaterThanOrEqual(canvas?.x ?? 0);
  expect((notice?.x ?? 0) + (notice?.width ?? Infinity)).toBeLessThanOrEqual(
    (canvas?.x ?? 0) + (canvas?.width ?? 0),
  );
});

async function dragFromAgent(
  page: Page,
  fixture: Locator,
  agentId: string,
  targetId: string,
): Promise<void> {
  await aimFromAgent(page, fixture, agentId, targetId);
  await page.mouse.up();
}

async function aimFromAgent(
  page: Page,
  fixture: Locator,
  agentId: string,
  targetId: string,
): Promise<void> {
  const from = await centreOf(
    fixture.locator(
      `.react-flow__node[data-id="${agentId}"] .react-flow__handle-bottom`,
    ),
  );
  const to = await centreOf(
    fixture.locator(`.react-flow__node[data-id="${targetId}"]`),
  );

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= DRAG_STEPS; step++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / DRAG_STEPS,
      from.y + ((to.y - from.y) * step) / DRAG_STEPS,
    );
  }
}

async function centreOf(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");

  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
