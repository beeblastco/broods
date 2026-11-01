/**
 * The GitHub starts follow the deployment: with a GitHub App the project's
 * Git tab offers to connect and Create project offers Import repo and New
 * repo; without one, Git says so and Create project stays a name field.
 */
import { expect, test } from "@playwright/test";
import { hasProbe, MISSING_PROBE, readProjectId } from "../lib/session";

test.skip(!hasProbe(), MISSING_PROBE);

// @rollout: needs the github functions, which the merge deploys.
test("Git settings and Create project match whether GitHub is set up @rollout", async ({
  page,
}) => {
  await page.goto(`/${readProjectId()}/settings?tab=git`);
  const notSetUp = page.getByText(
    "GitHub is not set up on this Broods deployment.",
  );
  await expect(
    page.getByRole("heading", { level: 2, name: "Git", exact: true }),
  ).toBeVisible();
  const configured = !(await notSetUp.isVisible());

  await page.goto("/projects");
  await page.getByRole("button", { name: "New Project" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/project name/i)).toBeVisible();
  const importTab = dialog.getByRole("tab", { name: "Import repo" });
  if (!configured) {
    await expect(importTab).toHaveCount(0);

    return;
  }
  await expect(dialog.getByRole("tab", { name: "New repo" })).toBeVisible();
  await importTab.click();
  await expect(importTab).toHaveAttribute("aria-selected", "true");
  // With no account connected yet the picker asks to connect one.
  await expect(
    dialog
      .getByRole("button", { name: "Connect GitHub" })
      .or(dialog.getByLabel("Repository")),
  ).toBeVisible();
});
