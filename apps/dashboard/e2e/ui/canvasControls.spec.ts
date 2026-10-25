import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

test("the save pill shows a save, clears after it lands, and keeps a failure", async ({
  page,
}) => {
  await openGallery(page);
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

  // The pill never overlaps the controls: it is centred, they are on the left.
  const controlsBox = (await controls
    .getByRole("button", { name: "Zoom in" })
    .boundingBox())!;
  const pillBox = (await pill.boundingBox())!;
  expect(pillBox.x).toBeGreaterThan(controlsBox.x + controlsBox.width);
});
