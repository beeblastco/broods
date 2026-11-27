import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

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
  const clips = await command.evaluate(
    (element) =>
      element.scrollWidth > element.clientWidth &&
      getComputedStyle(element).overflowX !== "auto",
  );
  expect(clips).toBe(false);
});
