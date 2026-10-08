import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// The search box turns a finished `field:value` token into a chip and hands
// the panel one joined query string, so the panel's parser sees the same text
// whether the token was typed or chipped.
test("a finished field token becomes a chip and stays in the query", async ({
  page,
}) => {
  await openGallery(page);
  const bar = page.locator('[data-fixture="observability-toolbar"]');
  const input = bar.getByRole("textbox", { name: "Search" });
  await input.fill("level:error timeout");

  await expect(
    bar.getByRole("button", { name: "Remove level:error" }),
  ).toBeVisible();
  await expect(input).toHaveValue("timeout");
  await expect(bar.locator("[data-toolbar-query]")).toHaveText(
    "level:error timeout",
  );

  // Backspace on empty text pulls the chip back into the input for editing.
  await input.fill("");
  await input.press("Backspace");
  await expect(input).toHaveValue("level:error");
  await expect(
    bar.getByRole("button", { name: "Remove level:error" }),
  ).toHaveCount(0);

  // Escape clears everything.
  await input.press("Escape");
  await expect(bar.locator("[data-toolbar-query]")).toHaveText("");
});

// Dragging across the volume strip narrows the range to a custom window and
// a click on it clears that window again.
test("dragging on the volume strip picks a window, a click clears it", async ({
  page,
}) => {
  await openGallery(page);
  const bar = page.locator('[data-fixture="observability-toolbar"]');
  const strip = bar.getByTitle("Drag to narrow the time window");
  const box = (await strip.boundingBox())!;

  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, {
    steps: 4,
  });
  await page.mouse.up();

  const window = bar.locator("[data-toolbar-window]");
  await expect(window).toBeVisible();
  const [from, to] = (await window.textContent())!.split("-").map(Number);
  // The fixture's hour runs up to its fixed clock; the pick is its third quarter.
  const hour = 60 * 60 * 1000;
  expect(to - from).toBeGreaterThan(hour * 0.2);
  expect(to - from).toBeLessThan(hour * 0.3);

  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height / 2);
  await expect(window).toHaveCount(0);
});
