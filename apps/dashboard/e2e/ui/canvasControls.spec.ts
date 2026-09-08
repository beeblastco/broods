import { expect, test } from "@playwright/test";

// Base UI gives the popup no ARIA role; the trigger is described by it instead.
const TOOLTIP = '[data-slot="tooltip-content"]';

test("each canvas control names itself in a tooltip", async ({ page }) => {
  await page.goto("/ui-gallery");
  const controls = page.locator('[data-fixture="canvas-controls"]');
  for (const label of [
    "Zoom in",
    "Zoom out",
    "Center the whole architecture",
    "Tidy up: re-lay out every node by its wiring",
  ]) {
    await controls.getByRole("button", { name: label }).hover();
    await expect(page.locator(TOOLTIP)).toHaveText(label);
    await page.mouse.move(0, 0);
    await expect(page.locator(TOOLTIP)).toHaveCount(0);
  }
});

test("the save pill shows a save, clears after it lands, and keeps a failure", async ({
  page,
}) => {
  await page.goto("/ui-gallery");
  const controls = page.locator('[data-fixture="canvas-controls"]');
  const pill = controls.locator("[aria-live]");

  await expect(pill).toHaveCount(0);
  await controls.locator('[data-save-state="saving"]').click();
  await expect(pill).toHaveText("Saving…");
  await controls.locator('[data-save-state="saved"]').click();
  await expect(pill).toHaveText("Saved");
  await expect(pill).toHaveCount(0, { timeout: 5_000 });

  await controls.locator('[data-save-state="error"]').click();
  await expect(pill).toContainText("Couldn't save");
  await expect(pill.getByRole("button", { name: "Retry" })).toBeVisible();

  // The pill never overlaps the controls: it sits in its own corner.
  const controlsBox = (await controls
    .getByRole("button", { name: "Zoom in" })
    .boundingBox())!;
  const pillBox = (await pill.boundingBox())!;
  expect(pillBox.y).toBeGreaterThan(controlsBox.y + controlsBox.height);
});
