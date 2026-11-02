import { expect, test, type Locator, type Page } from "@playwright/test";
import { openGallery } from "../lib/gallery";

type Point = { x: number; y: number };

// The drop target is read off mousemove: one jump never crosses the group it lands on.
const DRAG_STEPS = 12;

const SLOT_GAP = 8;

const SLOT_HEIGHT = 44;

test("a card dragged onto a frame opens a slot and lands in it", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-drop"]');
  await fixture.scrollIntoViewIfNeeded();
  const frame = fixture.locator('[data-slot="canvas-frame"]');
  const slot = fixture.locator('[data-slot="frame-drop-slot"]');
  const closedHeight = (await frame.boundingBox())?.height ?? 0;
  const chip = await nodeOf(fixture, "box-one").boundingBox();
  if (!chip) throw new Error("box-one has no box");
  const zoom = chip.height / SLOT_HEIGHT;

  await aim(page, fixture, "spare", await aboveMiddleOf(fixture, "box-one"));
  await expect(slot).toBeVisible();
  // The height is a transition: poll until it has finished growing.
  await expect
    .poll(async () =>
      Math.round(((await frame.boundingBox())?.height ?? 0) - closedHeight),
    )
    .toBe(Math.round((SLOT_HEIGHT + SLOT_GAP) * zoom));

  await page.mouse.up();
  await expect(fixture.locator('[data-testid="drop-log"]')).toHaveText(
    "joined Cloud sandbox at 0",
  );
  await expect(slot).toHaveCount(0);
  await expect(
    fixture.locator(
      '.react-flow__node[data-id="spare"] [data-slot="resource-chip"]',
    ),
  ).toBeVisible();
});

test("a workspace over a sandbox group is refused and opens no slot", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-drop"]');
  await fixture.scrollIntoViewIfNeeded();

  const log = fixture.locator('[data-testid="drop-log"]');
  // A good drop first, so the log has a line a refused drop could wrongly overwrite.
  await aim(page, fixture, "spare", await belowMiddleOf(fixture, "box-two"));
  await page.mouse.up();
  await expect(log).toHaveText("joined Cloud sandbox at 2");

  await aim(page, fixture, "notes", await aboveMiddleOf(fixture, "box-one"));
  await expect(fixture.locator('[data-slot="canvas-notice"]')).toContainText(
    "A workspace joins no sandbox group.",
  );
  await expect(fixture.locator('[data-slot="frame-drop-slot"]')).toHaveCount(0);

  await page.mouse.up();
  await expect(log).toHaveText("joined Cloud sandbox at 2");
  await expect(
    fixture.locator('.react-flow__node[data-id="notes"] [data-slot="card"]'),
  ).toBeVisible();
});

test("two loose cards outline the group they would form", async ({ page }) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-drop"]');
  await fixture.scrollIntoViewIfNeeded();
  const preview = fixture.locator('[data-slot="canvas-drop-preview"]');

  await aim(page, fixture, "spare", await centreOf(nodeOf(fixture, "solo")));
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Cloud sandbox");
  const box = await preview.boundingBox();
  const card = await nodeOf(fixture, "solo").boundingBox();
  expect(box?.width ?? 0).toBeLessThan((card?.width ?? 0) * 1.4);
  await expect(
    fixture.locator('[data-slot="canvas-drop-preview-slot"]'),
  ).toBeVisible();

  await page.mouse.up();
  await expect(fixture.locator('[data-testid="drop-log"]')).toContainText(
    "joined Cloud sandbox",
  );
  await expect(preview).toHaveCount(0);
  await expect(
    nodeOf(fixture, "solo").locator('[data-slot="resource-chip"]'),
  ).toBeVisible();
  await expect(
    nodeOf(fixture, "spare").locator('[data-slot="resource-chip"]'),
  ).toBeVisible();
});

async function aboveMiddleOf(fixture: Locator, nodeId: string): Promise<Point> {
  const box = await nodeOf(fixture, nodeId).boundingBox();
  if (!box) throw new Error(`${nodeId} has no box`);

  return { x: box.x + box.width / 2, y: box.y + 4 };
}

async function aim(
  page: Page,
  fixture: Locator,
  nodeId: string,
  to: Point,
): Promise<void> {
  const from = await centreOf(nodeOf(fixture, nodeId));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // React Flow counts travel from the first move past its 1px threshold: nudge first,
  // or a coarse first step leaves the card that far behind the cursor all drag.
  await page.mouse.move(from.x, from.y + 3);
  for (let step = 1; step <= DRAG_STEPS; step++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / DRAG_STEPS,
      from.y + ((to.y - from.y) * step) / DRAG_STEPS,
    );
  }
}

async function belowMiddleOf(fixture: Locator, nodeId: string): Promise<Point> {
  const box = await nodeOf(fixture, nodeId).boundingBox();
  if (!box) throw new Error(`${nodeId} has no box`);

  return { x: box.x + box.width / 2, y: box.y + box.height - 4 };
}

async function centreOf(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");

  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function nodeOf(fixture: Locator, nodeId: string): Locator {
  return fixture.locator(`.react-flow__node[data-id="${nodeId}"]`);
}
