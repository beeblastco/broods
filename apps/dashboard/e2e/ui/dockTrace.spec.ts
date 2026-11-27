import { expect, test } from "@playwright/test";

test("an answer's trace folds into one row that opens to each step's input and output", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=dock-apply");
  await page.locator('main[data-hydrated="true"]').waitFor();
  const trace = page.locator("[data-dock-trace]");
  const row = trace.getByRole("button", { name: "Worked for 9s · 5 tools" });

  await expect(row).toHaveAttribute("aria-expanded", "false");
  await row.click();
  await expect(trace).toContainText("Check what broods has");
  await expect(trace.locator('[data-dock-step="error"]')).toContainText(
    "web_fetch",
  );
  await expect(trace).toContainText("Opened Scheduler");

  await trace.getByRole("button", { name: /GET \/v1\/agents\/broods/ }).click();
  await expect(trace.locator("pre").first()).toContainText('"method": "GET"');
  await page.screenshot({
    path: "test-results/dock-trace.png",
  });
  await trace.getByRole("button", { name: /read_docs/ }).click();
  await expect(trace).toContainText("First 4 KB of 6 KB shown.");
});

test("a dashboard link in an answer navigates without a reload", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=dock-apply");
  await page.locator('main[data-hydrated="true"]').waitFor();
  await page.evaluate(() => {
    document.body.dataset.sameDocument = "true";
  });

  const external = page.getByRole("link", { name: "DeepWiki docs" });
  await expect(external).toHaveAttribute("target", "_blank");
  await page.getByRole("link", { name: "Scheduler" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-same-document",
    "true",
  );
});
