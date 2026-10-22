import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// The fixtures: one org's October across four projects, as Support bot's
// Usage tab and as the organization's Usage page show it.
const ALLOWANCE = '[data-fixture="allowance"]';
const ORG = '[data-fixture="allowance-org"]';

test("this project leads each resource, and its piece of the bar is its share of the org's", async ({
  page,
}) => {
  await openGallery(page);
  const allowance = page.locator(ALLOWANCE);
  const sandbox = allowance.getByRole("row", { name: /Sandbox time/ });

  await expect(
    allowance.getByRole("columnheader", { name: "This project" }),
  ).toBeVisible();
  await expect(sandbox).toContainText("28.9 h");
  await expect(sandbox).toContainText("92.7 h");
  await expect(sandbox).toContainText("129.8 h");
  await expect(sandbox).toContainText("65%");

  const track = (await sandbox.locator("div.bg-muted").boundingBox())!;
  const used = (await sandbox.locator("div.bg-muted > div").boundingBox())!;
  const own = (await sandbox
    .locator("div.bg-muted > div > div")
    .first()
    .boundingBox())!;
  // The bar reaches the pool's 65% of the limit; this project is 28.9 of
  // the pool's 129.8 hours, the rest is the org and the owner's other org.
  expect(used.width / track.width).toBeCloseTo(0.649, 1);
  expect(own.width / used.width).toBeCloseTo(28.9 / 129.8, 1);
});

test("a project's Resources links to the organization's Usage page", async ({
  page,
}) => {
  await openGallery(page);
  const allowance = page.locator(ALLOWANCE);

  await expect(
    // A Button rendering a Link, like Billing's View usage: an <a> with the button role.
    allowance.getByRole("button", { name: "All projects" }),
  ).toHaveAttribute("href", "/settings/org?tab=usage");
});

test("the organization's page lists every project, busiest first on the picked resource", async ({
  page,
}) => {
  await openGallery(page);
  const allowance = page.locator(ORG);

  const byProject = allowance.locator("section:has(> h3)").getByRole("row");
  const names = async (): Promise<string[]> =>
    (await byProject.locator("td:first-child").allTextContents()).map((name) =>
      name.replace("?", "").trim(),
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
  const allowance = page.locator(ORG);
  await allowance.scrollIntoViewIfNeeded();

  const box = (await allowance.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(allowance.getByRole("combobox")).toBeInViewport();
});
