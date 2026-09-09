import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// The level select once opened with a blank first row and its list pushed
// down from the trigger. The popup must sit flush under the trigger and show
// every option, the first one included.
test("the level select opens flush under its trigger with every option visible", async ({
  page,
}) => {
  await openGallery(page);
  const trigger = page.getByRole("combobox", { name: "Filter by log level" });
  await expect(trigger).toHaveText(/INFO/);
  await trigger.click();

  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const options = listbox.getByRole("option");
  await expect(options).toHaveText([
    "All levels",
    "ERROR",
    "WARN",
    "INFO",
    "DEBUG",
  ]);

  const triggerBox = (await trigger.boundingBox())!;
  const popupBox = (await listbox.boundingBox())!;
  const firstOptionBox = (await options.first().boundingBox())!;
  const gap = popupBox.y - (triggerBox.y + triggerBox.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(8);
  // The first option starts where the popup does, padding aside: no dead band.
  expect(firstOptionBox.y - popupBox.y).toBeLessThanOrEqual(12);
  expect(firstOptionBox.height).toBeGreaterThan(16);

  await options.filter({ hasText: "ERROR" }).click();
  await expect(trigger).toHaveText(/ERROR/);
});
