import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// The fixture: one org's October across four projects, seen from Support bot.
const ALLOWANCE = '[data-fixture="allowance"]';

test("this project leads each resource, and its piece of the bar is its share of the org's", async ({
  page,
}) => {
  await openGallery(page);
  const allowance = page.locator(ALLOWANCE);
  const sandbox = allowance.getByRole("row", { name: /Sandbox time/ });

  await expect(allowance.locator("[data-allowance-scope]")).toHaveAttribute(
    "data-allowance-scope",
    "project",
  );
  await expect(
    allowance.getByRole("columnheader", { name: "This project" }),
  ).toBeVisible();
  await expect(sandbox).toContainText("28.9 h");
  await expect(sandbox).toContainText("92.7 h");
  await expect(sandbox).toContainText("46%");

  const track = (await sandbox.locator("div.bg-muted").boundingBox())!;
  const used = (await sandbox.locator("div.bg-muted > div").boundingBox())!;
  const own = (await sandbox
    .locator("div.bg-muted > div > div")
    .first()
    .boundingBox())!;
  // The bar reaches the org's 46% of the limit; this project is 28.9 of
  // its 92.7 hours.
  expect(used.width / track.width).toBeCloseTo(0.464, 1);
  expect(own.width / used.width).toBeCloseTo(28.9 / 92.7, 1);
});

test("all projects lists every project, busiest first on the picked resource", async ({
  page,
}) => {
  await openGallery(page);
  const allowance = page.locator(ALLOWANCE);
  await allowance.getByRole("button", { name: "All projects" }).click();

  await expect(allowance.locator("[data-allowance-scope]")).toHaveAttribute(
    "data-allowance-scope",
    "all",
  );
  const byProject = allowance.locator("section:has(> h3)").getByRole("row");
  const names = async (): Promise<string[]> =>
    (await byProject.locator("td:first-child").allTextContents()).map((name) =>
      name.replace("This project", "").replace("?", "").trim(),
    );

  await expect(
    allowance.getByRole("columnheader", { name: "Share of Sandbox time" }),
  ).toBeVisible();
  expect(await names()).toEqual([
    "Research",
    "Support bot",
    "Sales agent",
    "Internal tools",
    "Other usage",
  ]);

  await allowance.getByRole("row", { name: /^Egress/ }).click();
  await expect(
    allowance.getByRole("columnheader", { name: "Share of Egress" }),
  ).toBeVisible();
  // Other usage stays last whatever it holds.
  expect((await names())[0]).toBe("Support bot");
  expect((await names()).at(-1)).toBe("Other usage");
  await expect(
    byProject.filter({ hasText: "Support bot" }).getByRole("link"),
  ).toHaveAttribute("href", "/support-bot/dashboard?tab=usage");
});

test("on a phone the tables scroll inside their card, not the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openGallery(page);
  const allowance = page.locator(ALLOWANCE);
  await allowance.getByRole("button", { name: "All projects" }).click();

  const box = (await allowance.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(allowance.getByRole("combobox")).toBeInViewport();
});
