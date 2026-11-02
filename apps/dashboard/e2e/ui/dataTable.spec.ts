import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

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

  await table.getByRole("button", { name: "Remove agent:support-bot" }).click();
  await expect(names).toHaveCount(4);
});

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
