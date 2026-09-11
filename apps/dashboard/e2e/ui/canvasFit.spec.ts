import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// Opening the Architecture tab used to leave the graph at half size, so the
// architecture has to own most of the frame it is fitted into.
const MIN_FRAME_SHARE = 0.85;

test("the canvas opens with the architecture filling the frame", async ({
  page,
}) => {
  await openGallery(page);
  const frame = page.locator('[data-fixture="canvas-fit"] .react-flow');
  const nodes = frame.locator(".react-flow__node");
  await expect(nodes).toHaveCount(6);

  const frameBox = (await frame.boundingBox())!;
  const boxes = await Promise.all(
    (await nodes.all()).map(async (node) => (await node.boundingBox())!),
  );
  const left = Math.min(...boxes.map((box) => box.x));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const top = Math.min(...boxes.map((box) => box.y));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const share = Math.max(
    (right - left) / frameBox.width,
    (bottom - top) / frameBox.height,
  );

  expect(share).toBeGreaterThan(MIN_FRAME_SHARE);
});
