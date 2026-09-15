import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

/** StatusDot's `size-2`. */
const DOT_PX = 8;

test("a status dot keeps its size straight in a table cell", async ({
  page,
}) => {
  await openGallery(page);
  // The stand-in log table puts the dot straight in a cell with no flex row
  // around it, the way Tracing and the sandbox tables do.
  const dot = page
    .locator('[data-fixture="observability-toolbar"] td [title="ok"]')
    .first();

  await expect(dot).toBeVisible();
  const box = (await dot.boundingBox())!;
  expect(box.width).toBe(DOT_PX);
  expect(box.height).toBe(DOT_PX);
});
