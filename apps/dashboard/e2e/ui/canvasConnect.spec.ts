import { expect, test, type Locator, type Page } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// How many steps a drag takes. React Flow reads the connection off mousemove,
// so one jump from start to finish never picks a drop target.
const DRAG_STEPS = 12;

/**
 * Dropping an agent's edge on a node used to need the pointer within React
 * Flow's 20px default of the target's top handle, a dot smaller than the nodes
 * around it. A drop on the body of a card, or anywhere on a 44px chip inside a
 * frame, found no handle and silently did nothing.
 */
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

  // A sandbox nobody wired yet, drawn as a loose card.
  await dragFromAgent(page, fixture, "beta", "fresh-box");
  await expect(log).toContainText("xy-edge__beta-fresh-boxtop");

  // A chip inside the frame another agent owns; the second agent joins it.
  await dragFromAgent(page, fixture, "beta", "box-one");
  await expect(log).toContainText("xy-edge__beta-box-onetop");
});

/**
 * A refused drop used to vanish with nothing on screen to say why. The reason
 * shows at the top while the line is aimed at the card, and stays after the
 * drop until it is dismissed.
 */
test("a refused connection says why, while aimed and after the drop", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-connect"]');
  await fixture.scrollIntoViewIfNeeded();
  const notice = fixture.locator('[data-slot="canvas-refusal"]');
  const target = fixture.locator('.react-flow__node[data-id="box-one"]');

  await aimFromAgent(page, fixture, "alpha", "box-one");
  await expect(notice).toContainText("alpha is already connected to box-one.");
  await expect(notice).toContainText("Release to cancel");
  await expect(target).toHaveClass(/canvas-refused/);

  await page.mouse.up();
  await expect(notice).toContainText("alpha is already connected to box-one.");
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
});

/** Press the agent's bottom handle and release over the target's middle. */
async function dragFromAgent(
  page: Page,
  fixture: Locator,
  agentId: string,
  targetId: string,
): Promise<void> {
  await aimFromAgent(page, fixture, agentId, targetId);
  await page.mouse.up();
}

/** Press the agent's bottom handle and hold the line over the target's middle. */
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
