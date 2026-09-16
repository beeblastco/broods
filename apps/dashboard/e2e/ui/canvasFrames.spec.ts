import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// Chips are measured against frames on screen; a pixel of slack covers the
// sub-pixel rounding of the fitted zoom.
const SLACK = 1;

// Distance between the points sampled along an edge path, in flow units.
const PATH_STEP = 4;

test("chips sit inside their frames and a collapsed frame is one card", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');
  const chips = fixture.locator('[data-slot="resource-chip"]');
  const expanded = fixture.locator(
    '[data-slot="canvas-frame"][data-collapsed="false"]',
  );
  const collapsed = fixture.locator(
    '[data-slot="canvas-frame"][data-collapsed="true"]',
  );

  // Cloud, computer (2), workspaces (3), hosted MCP, machine MCP.
  await expect(chips).toHaveCount(8);
  await expect(expanded).toHaveCount(5);
  await expect(collapsed).toHaveCount(1);
  await expect(collapsed).toContainText("github, linear");
  await expect(chips.filter({ hasText: /github|linear/ })).toHaveCount(0);

  const frameBoxes = await Promise.all(
    (await expanded.all()).map(async (frame) => (await frame.boundingBox())!),
  );
  for (const chip of await chips.all()) {
    const box = (await chip.boundingBox())!;
    const inside = frameBoxes.some(
      (frame) =>
        box.x >= frame.x - SLACK &&
        box.y >= frame.y - SLACK &&
        box.x + box.width <= frame.x + frame.width + SLACK &&
        box.y + box.height <= frame.y + frame.height + SLACK,
    );
    expect(inside, await chip.innerText()).toBe(true);
  }
});

test("chip names and status lines fit without truncating", async ({ page }) => {
  await openGallery(page);
  const clipped = await page
    .locator(
      '[data-fixture="canvas-frames"] [data-slot="resource-chip"] .truncate',
    )
    .evaluateAll((spans) =>
      spans
        .filter((span) => span.scrollWidth > span.clientWidth)
        .map((span) => span.textContent),
    );

  expect(clipped).toEqual([]);
});

test("the mount and runs-on edges are drawn between chips", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');

  await expect(
    fixture.locator(".react-flow__edge-mount path.react-flow__edge-path"),
  ).toHaveAttribute("d", /\S/);
  await expect(
    fixture.locator(".react-flow__edge-runsOn path.react-flow__edge-path"),
  ).toHaveAttribute("d", /\S/);
});

test("no bundle edge crosses a frame other than the one it enters", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-frames"]');
  await expect(
    fixture.locator('.react-flow__edge[data-id^="bundle:"]'),
  ).toHaveCount(6);

  const crossings = await fixture.evaluate((root, step) => {
    const frames = [
      ...root.querySelectorAll<HTMLElement>(".react-flow__node-frame"),
    ].map((frame) => ({
      id: frame.dataset.id ?? "",
      rect: frame.getBoundingClientRect(),
    }));
    const edges = [
      ...root.querySelectorAll<SVGGElement>(
        '.react-flow__edge[data-id^="bundle:"]',
      ),
    ];

    return edges.flatMap((edge) => {
      const id = edge.dataset.id ?? "";
      // bundle:{agentId}:{frameId}, and frame ids start with "frame:".
      const targetId = id.slice(id.indexOf(":frame:") + 1);
      const path = edge.querySelector<SVGPathElement>(
        "path.react-flow__edge-path",
      );
      const matrix = path?.getScreenCTM();
      if (!path || !matrix) return [`${id}: no path`];
      const hits = new Set<string>();
      for (let length = 0; length <= path.getTotalLength(); length += step) {
        const point = path.getPointAtLength(length).matrixTransform(matrix);
        for (const { id: frameId, rect } of frames) {
          if (
            frameId !== targetId &&
            point.x > rect.left + 1 &&
            point.x < rect.right - 1 &&
            point.y > rect.top + 1 &&
            point.y < rect.bottom - 1
          ) {
            hits.add(`${id} crosses ${frameId}`);
          }
        }
      }

      return [...hits];
    });
  }, PATH_STEP);

  expect(crossings).toEqual([]);
});
