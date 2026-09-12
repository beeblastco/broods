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

// The popup renders in a portal, but Base UI transforms its positioner, so the
// positioner is the stacking context the page competes with. With the z-index
// only on the popup inside it, the log table's sticky head painted over
// whichever option it overlapped and ate the click that should have picked it.
test("the level select popup covers the sticky table head under it", async ({
  page,
}) => {
  await openGallery(page);
  const trigger = page.getByRole("combobox", { name: "Filter by log level" });
  await trigger.click();
  await expect(page.getByRole("listbox")).toBeVisible();

  const stickyHead = page.locator("thead.sticky").first();
  const headBox = (await stickyHead.boundingBox())!;
  const popupBox = (await page.getByRole("listbox").boundingBox())!;
  // The fixture is only meaningful while the two actually overlap.
  expect(headBox.y).toBeLessThan(popupBox.y + popupBox.height);

  const buried = await page.evaluate(() => {
    const popup = document.querySelector('[data-slot="select-content"]')!;

    return [...popup.querySelectorAll('[data-slot="select-item"]')]
      .filter((item) => {
        const box = item.getBoundingClientRect();
        const onTop = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );

        return !popup.contains(onTop);
      })
      .map((item) => item.textContent);
  });
  expect(buried).toEqual([]);

  // The option the head used to swallow still selects on a real click.
  await page.getByRole("option").filter({ hasText: "ERROR" }).click();
  await expect(trigger).toHaveText(/ERROR/);
});
