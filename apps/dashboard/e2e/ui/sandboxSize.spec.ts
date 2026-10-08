import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

test("an unknown sandbox size is a ? that says why on hover and leaves its row closed", async ({
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

  await section.locator('[data-provider="machine"] button').click();
  await expect(section.getByTestId("size-row-opened")).toHaveText("none");
});
