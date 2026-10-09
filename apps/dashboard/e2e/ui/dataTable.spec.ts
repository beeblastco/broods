import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// A header menu sorts the column either way and filters by its values; the
// filter lands as a chip in the search box, the same one typing would make.
test("the header menu sorts and filters, and the filter is a search chip", async ({
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

  await table.getByRole("button", { name: "Name" }).click();
  await page.getByRole("menuitem", { name: "Sort Z to A" }).click();
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

// An avatar in a cell is one text line tall, so a row with a Who is no
// taller than one with only words: 12px text on its 16px line plus the cell's
// padding, and the columns stay where they are from row to row.
test("a row with an avatar is one text line tall", async ({ page }) => {
  await openGallery(page);
  const table = page.locator('[data-fixture="data-table"]');
  const row = table.locator("tbody tr").first();
  await expect(row.locator('[data-slot="avatar"]')).toBeVisible();
  const box = await row.boundingBox();
  expect(box?.height).toBeLessThanOrEqual(33);
});
