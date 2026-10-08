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
