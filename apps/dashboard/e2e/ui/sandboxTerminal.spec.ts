import { expect, test } from "@playwright/test";

test("the terminal fills the dock and draws in a real monospace font", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=sandbox");
  // The stand-in has no hydration marker, so click until React owns the row.
  const open = page.getByRole("button", { name: "Terminal", exact: true });
  await expect(async () => {
    await page.getByText("browser", { exact: true }).first().click();
    await expect(open).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await open.click();

  // Before a connect there is no state word, only a Connect button over the
  // shell for a role that may write, and no explainer.
  await expect(page.getByText("Not connected")).toHaveCount(0);
  await expect(page.getByText("Interactive shell inside")).toHaveCount(0);

  // xterm sizes its cells on a canvas, where var() does not resolve: handed
  // the font stack as a variable, it measures a fallback font and pads every
  // glyph of the real one with letter spacing to fill the cell.
  const rows = page.locator(".xterm-rows");
  await expect(rows).toHaveCount(1);
  const spacing = await rows.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).letterSpacing),
  );
  expect(Math.abs(spacing)).toBeLessThan(0.5);
});
