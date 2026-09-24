import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

/** The chart's top padding, above which no layer may draw. */
const PAD_TOP_PX = 6;
// A tween runs 600ms; wait past it before measuring.
const SETTLE_MS = 800;

test("a cache-heavy stack fits the chart instead of drawing past its top", async ({
  page,
}) => {
  await openGallery(page);
  const chart = page.locator('[data-fixture="usage-chart"] svg').first();
  await expect(chart).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);

  const svg = (await chart.boundingBox())!;
  const tops = await chart
    .locator("path")
    .evaluateAll((paths) =>
      paths.map((path) => path.getBoundingClientRect().top),
    );
  const highest = Math.min(...tops);

  // Stacked parts sum to the total the scale is built from, so the tallest
  // bin sits inside the frame and still fills most of it.
  expect(highest).toBeGreaterThanOrEqual(svg.y + PAD_TOP_PX - 1);
  expect(highest).toBeLessThan(svg.y + svg.height / 2);
});

test("y ticks are round numbers", async ({ page }) => {
  await openGallery(page);
  const labels = await page
    .locator('[data-fixture="usage-chart"] svg text[x="2"]')
    .allTextContents();

  expect(labels.length).toBeGreaterThan(1);
  for (const label of labels) expect(label).toMatch(/^\d+(\.5)?K$/);
});

test("clicking or pressing Enter on a bin selects it", async ({ page }) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="usage-chart"]');
  const chart = fixture.locator("button[aria-label^='Usage over time']");
  const box = (await chart.boundingBox())!;

  await chart.click({ position: { x: box.width * 0.99, y: box.height / 2 } });
  await expect(fixture.locator("[data-selected]")).toHaveAttribute(
    "data-selected",
    "11",
  );

  await chart.press("ArrowLeft");
  await chart.press("Enter");
  await expect(fixture.locator("[data-selected]")).toHaveAttribute(
    "data-selected",
    "10",
  );
});

test("switching bin count redraws every bin", async ({ page }) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="usage-chart"]');
  await fixture.getByRole("button", { name: "24 bins" }).click();
  await page.waitForTimeout(SETTLE_MS);
  const chart = fixture.locator("button[aria-label^='Usage over time']");
  const box = (await chart.boundingBox())!;

  await chart.click({ position: { x: box.width * 0.99, y: box.height / 2 } });
  await expect(fixture.locator("[data-selected]")).toHaveAttribute(
    "data-selected",
    "23",
  );
});
