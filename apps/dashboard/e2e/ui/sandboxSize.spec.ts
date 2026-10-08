import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

test("an unknown sandbox size is a ? that says why on hover", async ({
  page,
}) => {
  await openGallery(page);
  const section = page.locator('[data-fixture="sandbox-size"]');

  await expect(section.locator('[data-provider="daytona"]')).toContainText(
    "2 vCPU · 4 GB · 10 GB",
  );
  const disk = section.locator('[data-provider="e2b"] button');
  await expect(disk).toHaveText("?");

  await disk.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
    "E2B does not report a sandbox's disk size.",
  );

  // A row written before sizes were verified shows no guess.
  await expect(section.locator('[data-provider="lambda"]')).not.toContainText(
    "vCPU",
  );
  const unverified = section.locator('[data-provider="lambda"] button');
  await expect(unverified).toHaveText("?");
  await unverified.hover();
  await expect(
    page.getByText("Recorded before Broods checked sandbox sizes", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(section.locator('[data-provider="machine"] button')).toHaveText(
    "?",
  );
});
