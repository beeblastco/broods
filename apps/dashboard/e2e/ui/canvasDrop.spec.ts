import { expect, test, type Locator, type Page } from "@playwright/test";
import { openGallery } from "../lib/gallery";

/** A spot on screen, which is where every drag in here is aimed. */
type Point = { x: number; y: number };

/**
 * How many steps a drag takes. The drop target is read off mousemove, so one
 * jump from start to finish never crosses the group it lands on.
 */
const DRAG_STEPS = 12;

/** The gap between two slots, added to the frame along with the slot. */
const SLOT_GAP = 8;

/** A chip's slot, the height a pending slot adds to the frame. */
const SLOT_HEIGHT = 44;

/**
 * Nothing used to happen when a card was dragged onto a group: membership is
 * derived, so the card sat on top of the frame and the next layout pass moved it
 * away. The frame now opens the slot the card would take and takes it on release.
 */
test("a card dragged onto a frame opens a slot and lands in it", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-drop"]');
  await fixture.scrollIntoViewIfNeeded();
  const frame = fixture.locator('[data-slot="canvas-frame"]');
  const slot = fixture.locator('[data-slot="frame-drop-slot"]');
  const closedHeight = (await frame.boundingBox())?.height ?? 0;
  // The gallery fits the graph to its box, so every length on screen carries
  // that zoom. A chip is SLOT_HEIGHT flow pixels tall, which recovers it.
  const chip = await nodeOf(fixture, "box-one").boundingBox();
  if (!chip) throw new Error("box-one has no box");
  const zoom = chip.height / SLOT_HEIGHT;

  await aim(page, fixture, "spare", await aboveMiddleOf(fixture, "box-one"));
  await expect(slot).toBeVisible();
  // The box grew by exactly the slot it opened, so the chips have room. Its
  // height is a transition, so this polls until it has finished growing.
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
  // It is a chip now, which is what being in a group looks like.
  await expect(
    fixture.locator(
      '.react-flow__node[data-id="spare"] [data-slot="resource-chip"]',
    ),
  ).toBeVisible();
});

/** The slot is the one under the cursor, so a card lands where it was dropped. */
test("a card dropped under the last chip lands under it", async ({ page }) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-drop"]');
  await fixture.scrollIntoViewIfNeeded();

  await aim(page, fixture, "spare", await belowMiddleOf(fixture, "box-two"));
  await page.mouse.up();

  await expect(fixture.locator('[data-testid="drop-log"]')).toHaveText(
    "joined Cloud sandbox at 2",
  );
});

/**
 * A group takes only its own kind, and a card dropped on one that will not have
 * it used to be silently returned. The frame says why instead, and opens no slot.
 */
test("a workspace over a sandbox group is refused and opens no slot", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-drop"]');
  await fixture.scrollIntoViewIfNeeded();

  const log = fixture.locator('[data-testid="drop-log"]');
  // A drop that works first, so the log has something a refused drop could
  // wrongly overwrite.
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
  // Still a card, still out of every group.
  await expect(
    fixture.locator('.react-flow__node[data-id="notes"] [data-slot="card"]'),
  ).toBeVisible();
});

/**
 * Two loose cards have no frame to grow, so the group they would form is drawn
 * around them, already named.
 */
test("two loose cards outline the group they would form", async ({ page }) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-drop"]');
  await fixture.scrollIntoViewIfNeeded();
  const preview = fixture.locator('[data-slot="canvas-drop-preview"]');

  await aim(page, fixture, "spare", await centreOf(nodeOf(fixture, "solo")));
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Cloud sandbox");
  // The box is the frame that will form, one chip wide, not a box drawn around
  // wherever the two cards happen to be sitting.
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
  // Both are chips in the frame the two of them now make.
  await expect(
    nodeOf(fixture, "solo").locator('[data-slot="resource-chip"]'),
  ).toBeVisible();
  await expect(
    nodeOf(fixture, "spare").locator('[data-slot="resource-chip"]'),
  ).toBeVisible();
});

/** A point in a chip's top half, where a card's middle lands above that chip. */
async function aboveMiddleOf(fixture: Locator, nodeId: string): Promise<Point> {
  const box = await nodeOf(fixture, nodeId).boundingBox();
  if (!box) throw new Error(`${nodeId} has no box`);

  return { x: box.x + box.width / 2, y: box.y + 4 };
}

/** Press a card's middle and hold it over a point, without releasing. */
async function aim(
  page: Page,
  fixture: Locator,
  nodeId: string,
  to: Point,
): Promise<void> {
  const from = await centreOf(nodeOf(fixture, nodeId));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // React Flow counts the card's travel from the first move past its 1px
  // threshold, so nudge 3px before the real steps: a coarse first one would
  // leave the card that far behind the cursor for the whole drag.
  await page.mouse.move(from.x, from.y + 3);
  for (let step = 1; step <= DRAG_STEPS; step++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / DRAG_STEPS,
      from.y + ((to.y - from.y) * step) / DRAG_STEPS,
    );
  }
}

/** A point in a chip's bottom half, where a card's middle lands below that chip. */
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
