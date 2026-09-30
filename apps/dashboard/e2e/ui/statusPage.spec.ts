import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

test("a status page under the header fills its box and shows the Convex ref", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="status-page"]');
  const frame = fixture.locator("[data-status-frame]");
  const status = frame.getByRole("main");

  await expect(
    status.getByRole("heading", { name: "Workspace setup failed" }),
  ).toBeVisible();
  // The request id is the only part of a production Convex error worth
  // showing; the rest of the message is not.
  await expect(status).toContainText("Ref 4f1c9a2e7b3d0a51");
  await expect(status).not.toContainText("Called by client");
  await expect(status.getByRole("button", { name: "Retry" })).toBeVisible();

  const frameBox = (await frame.boundingBox())!;
  const statusBox = (await status.boundingBox())!;
  expect(statusBox.y).toBe(frameBox.y);
  expect(statusBox.height).toBe(frameBox.height);
  expect(statusBox.width).toBe(frameBox.width);
});
