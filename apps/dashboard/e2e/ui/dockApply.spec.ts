import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function openDock(page: Page): Promise<void> {
  await page.goto("/ui-gallery?tab=dock-apply");
  await page.locator('main[data-hydrated="true"]').waitFor();
}

test("a proposal reads as one bar, one chat line and dashed nodes", async ({
  page,
}) => {
  await openDock(page);
  const bar = page.locator("[data-apply-bar]");
  const status = page.locator("[data-apply-status]");

  await expect(bar).toHaveAttribute("data-apply-bar", "proposed");
  await expect(bar).toContainText("Connect DeepWiki to broods");
  await expect(bar.locator("[data-apply-code]")).toHaveText("3 files +7 −3");
  await expect(status).toHaveText(
    "Proposed. Review it at the top of the canvas.",
  );
  await expect(page.locator('[data-proposed-node="add"]')).toHaveText(
    /deepwiki/,
  );
  await expect(page.locator("[data-plan-diff]")).toHaveCount(0);
  await page.screenshot({ path: "test-results/dock-apply/proposed.png" });
});

test("the code drawer is the only diff, and a file can be dropped from it", async ({
  page,
}) => {
  await openDock(page);
  const bar = page.locator("[data-apply-bar]");
  await bar.locator("[data-apply-code]").click();

  const drawer = bar.locator("[data-apply-drawer]");
  await expect(drawer.locator("[data-plan-diff]")).toHaveCount(3);
  await expect(drawer).toContainText("-export const notes");
  await page.screenshot({ path: "test-results/dock-apply/code-open.png" });

  await drawer
    .locator("[data-apply-change]")
    .filter({ hasText: "broods/notes.ts" })
    .getByRole("button", { name: "Drop this change" })
    .click();
  await expect(drawer.locator("[data-plan-diff]")).toHaveCount(2);
  await expect(bar.locator("[data-apply-code]")).toHaveText("2 files +7 −2");
});

test("Apply turns the bar into plain deploy progress, then it leaves once deployed", async ({
  page,
}) => {
  await openDock(page);
  const bar = page.locator("[data-apply-bar]");
  const status = page.locator("[data-apply-status]");

  await bar.getByRole("button", { name: "Apply" }).click();
  await expect(bar).toHaveAttribute("data-apply-bar", "applying");
  await expect(bar).toContainText(/Deploying to Development · 0:4\d/);
  await expect(bar.getByRole("link", { name: "Run" })).toBeVisible();
  await expect(bar.getByRole("button")).toHaveCount(0);
  await expect(status).toHaveText("Committed 8d7ea8b to dev. Deploying.");
  await expect(page.locator('[data-proposed-node="add"]')).toHaveCount(1);
  await page.screenshot({ path: "test-results/dock-apply/applying.png" });

  await page.locator('[data-set-phase="deployed"]').click();
  await expect(bar).toHaveCount(0);
  await expect(status).toHaveText("Deployed in 58 s. Run");
  await expect(page.locator("[data-proposed-node]")).toHaveCount(0);
  await page.screenshot({ path: "test-results/dock-apply/deployed.png" });
});

test("a failed deploy says why, turns the nodes red, and offers Retry", async ({
  page,
}) => {
  await openDock(page);
  await page.locator('[data-set-phase="failed"]').click();
  const bar = page.locator("[data-apply-bar]");

  await expect(bar).toHaveAttribute("data-apply-bar", "failed");
  await expect(bar).toContainText("Deploy failed");
  await expect(bar.getByRole("link", { name: "Run" })).toBeVisible();
  await expect(page.locator("[data-apply-status]")).toHaveText(
    "Deploy failed: the run failed.",
  );
  await expect(page.locator('[data-proposed-node="failed"]')).toHaveCount(1);
  await page.screenshot({ path: "test-results/dock-apply/failed.png" });

  await bar.getByRole("button", { name: "Retry" }).click();
  await expect(bar).toHaveAttribute("data-apply-bar", "applying");
});

test("Discard removes the bar and the proposed nodes", async ({ page }) => {
  await openDock(page);
  await page
    .locator("[data-apply-bar]")
    .getByRole("button", { name: "Discard" })
    .click();

  await expect(page.locator("[data-apply-bar]")).toHaveCount(0);
  await expect(page.locator("[data-proposed-node]")).toHaveCount(0);
  await expect(page.locator("[data-apply-status]")).toHaveText(
    "Discarded. Nothing was changed.",
  );
  await page.screenshot({ path: "test-results/dock-apply/discarded.png" });
});

test("a verifying apply is live with no dashed nodes; out of sync is one bar with Sync", async ({
  page,
}) => {
  await openDock(page);
  const bar = page.locator("[data-apply-bar]");

  await page.locator('[data-set-phase="verifying"]').click();
  await expect(bar).toHaveAttribute("data-apply-bar", "verifying");
  await expect(bar).toContainText(
    /Live on Development\. Verifying dev deploy · 0:4\d/,
  );
  await expect(page.locator("[data-proposed-node]")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Discard" })).toHaveCount(0);

  await page.locator('[data-set-phase="out-of-sync"]').click();
  await expect(bar).toHaveAttribute("data-apply-bar", "out-of-sync");
  await expect(bar).toContainText("Out of sync");
  await expect(bar.getByRole("button", { name: "Sync" })).toBeVisible();
  await page.screenshot({ path: "test-results/dock-apply/out-of-sync.png" });
});
