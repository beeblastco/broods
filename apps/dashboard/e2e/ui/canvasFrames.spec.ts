import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

// Chips are measured against frames on screen; a pixel of slack covers the
// sub-pixel rounding of the fitted zoom.
const SLACK = 1;

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
