import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// The last onboarding step holds a long one-line command. It used to widen
// the card past its own border and push the footer with it.
test("the onboarding card keeps its command block inside its edges", async ({
  page,
}) => {
  await openGallery(page);
  await page.getByRole("button", { name: "Open onboarding" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  const command = dialog.locator("pre");
  await expect(command).toContainText("npm install -g broods");

  const dialogBox = (await dialog.boundingBox())!;
  const commandBox = (await command.boundingBox())!;
  const doneBox = (await dialog
    .getByRole("button", { name: "Done" })
    .boundingBox())!;
  expect(commandBox.x + commandBox.width).toBeLessThanOrEqual(
    dialogBox.x + dialogBox.width,
  );
  expect(doneBox.x + doneBox.width).toBeLessThanOrEqual(
    dialogBox.x + dialogBox.width,
  );
  // The command itself scrolls inside its block instead of clipping.
  const scrolls = await command.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(scrolls).toBe(true);
});
