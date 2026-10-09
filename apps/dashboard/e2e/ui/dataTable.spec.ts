import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// A sort-only header flips on a click; a filterable one opens a menu that
// sorts either way and filters by its values, and the filter lands as a chip
// in the search box, the same one typing would make.
test("a header click sorts, the header menu filters, and the filter is a search chip", async ({
  page,
}) => {
  await openGallery(page);
  const table = page.locator('[data-fixture="data-table"]');
  const names = table.locator("tbody tr td:first-child");
  await expect(names).toHaveText([
    "Daily summary",
    "Health probe",
    "Invoice sweep",
    "Weekly digest",
  ]);

  // Already sorted by name ascending, so one click flips it.
  await table.getByRole("button", { name: "Name" }).click();
  await expect(names.first()).toHaveText("Weekly digest");

  await table.getByRole("button", { name: "Agent" }).click();
  await page.getByRole("menuitemcheckbox", { name: "support-bot" }).click();
  await page.keyboard.press("Escape");
  await expect(names).toHaveText(["Weekly digest", "Daily summary"]);
  await expect(
    table.getByRole("button", { name: "Remove agent:support-bot" }),
  ).toBeVisible();
  await expect(table.locator("[data-table-query]")).toHaveText(
    "agent:support-bot",
  );

  // The chip's remove button clears the filter the header set.
  await table.getByRole("button", { name: "Remove agent:support-bot" }).click();
  await expect(names).toHaveCount(4);
});

// The Filter button reaches the same value lists by column.
test("the Filter button sets the same chip as the header", async ({ page }) => {
  await openGallery(page);
  const table = page.locator('[data-fixture="data-table"]');
  await table.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("menuitem", { name: "Status" }).hover();
  await page.getByRole("menuitemcheckbox", { name: "failed" }).click();
  await page.keyboard.press("Escape");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("[data-table-query]")).toHaveText("status:failed");
});

// Two values of one field widen the filter; a value of another field narrows it.
test("two chips on one field keep rows matching either", async ({ page }) => {
  await openGallery(page);
  const table = page.locator('[data-fixture="data-table"]');
  const names = table.locator("tbody tr td:first-child");
  await table.getByRole("button", { name: "Agent" }).click();
  await page.getByRole("menuitemcheckbox", { name: "support-bot" }).click();
  await page.getByRole("menuitemcheckbox", { name: "billing" }).click();
  await page.keyboard.press("Escape");
  await expect(names).toHaveText([
    "Daily summary",
    "Invoice sweep",
    "Weekly digest",
  ]);

  await table.getByRole("button", { name: "Status" }).click();
  await page.getByRole("menuitemcheckbox", { name: "failed" }).click();
  await page.keyboard.press("Escape");
  await expect(names).toHaveText(["Invoice sweep"]);
});

// An avatar in a cell is no taller than the cell's text line, so a row with
// a Who is as tall as one with only words and the columns stay where they
// are from row to row.
test("an avatar in a cell is one text line tall", async ({ page }) => {
  await openGallery(page);
  const table = page.locator('[data-fixture="data-table"]');
  const avatar = table.locator('tbody [data-slot="avatar"]').first();
  await expect(avatar).toBeVisible();
  const cell = avatar.locator("xpath=ancestor::td[1]");
  const lineHeight = await cell.evaluate((element) =>
    parseFloat(getComputedStyle(element).lineHeight),
  );
  const box = await avatar.boundingBox();
  expect(box?.height).toBeLessThanOrEqual(lineHeight);
});
