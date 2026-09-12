import { expect, test, type Locator, type Page } from "@playwright/test";
import { openGallery } from "../lib/gallery";

/** Every control the fixture puts under a press, by accessible name. */
const CONTROLS = [
  { role: "button", name: "Deploy the stage" },
  { role: "tab", name: "Config" },
  { role: "combobox", name: "Press filter" },
  { role: "link", name: "Architecture" },
] as const;

/** How far a press wanders when the hand is not perfectly still. */
const TRAVEL = { x: 8, y: 4 };

/** Far enough to clear Chromium's native drag threshold. */
const SLIDE = { x: 40, y: 12 };

test("a press that wanders still activates the control", async ({ page }) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="press-drag"]');

  await pressWithTravel(
    page,
    fixture.getByRole("button", { name: "Deploy the stage" }),
  );
  await expect(fixture.locator("[data-press-count]")).toHaveText("1");

  await pressWithTravel(page, fixture.getByRole("tab", { name: "Config" }));
  await expect(fixture.locator("[data-press-tab]")).toHaveText("Config");

  await pressWithTravel(
    page,
    fixture.getByRole("combobox", { name: "Press filter" }),
  );
  await pressWithTravel(page, page.getByRole("option", { name: "WARN" }));
  await expect(fixture.locator("[data-press-level]")).toHaveText("WARN");
});

test("a press on a control, or in the gap beside one, neither selects nor drags", async ({
  page,
}) => {
  await openGallery(page);
  await countDragStarts(page);
  const fixture = page.locator('[data-fixture="press-drag"]');

  for (const control of CONTROLS) {
    const target = fixture.getByRole(control.role, { name: control.name });
    await pressWithTravel(page, target, SLIDE);

    expect(await selectedText(page), control.name).toBe("");
    expect(await dragStarts(page), control.name).toBe(0);
    await page.keyboard.press("Escape");
  }

  // The press that actually broke: it lands a pixel or two off the control,
  // so the sweep that follows paints every label on the row instead.
  for (const strip of ['[data-slot="tabs-list"]', "nav"]) {
    await sweep(page, fixture.locator(strip).first());
    expect(await selectedText(page), strip).toBe("");
    expect(await dragStarts(page), strip).toBe(0);
  }
});

test("a field inside that chrome still selects its own text", async ({
  page,
}) => {
  await openGallery(page);
  const search = page
    .locator('[data-fixture="observability-toolbar"]')
    .getByPlaceholder("Search logs…");

  await search.fill("timeout");
  await sweep(page, search, 34);

  // A field keeps its selection in `selectionStart`/`selectionEnd`, not in the
  // document selection, so read it off the element.
  const selected = await search.evaluate((element: HTMLInputElement) =>
    element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0),
  );
  expect(selected).toBe("timeout");
});

/** Install a dragstart tally on the page; read it back with `dragStarts`. */
async function countDragStarts(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.dragStarts = "0";
    document.addEventListener("dragstart", () => {
      const root = document.documentElement;
      root.dataset.dragStarts = String(Number(root.dataset.dragStarts) + 1);
    });
  });
}

async function dragStarts(page: Page): Promise<number> {
  return await page.evaluate(() =>
    Number(document.documentElement.dataset.dragStarts),
  );
}

/** Press the control, slide the pointer, then let go. */
async function pressWithTravel(
  page: Page,
  control: Locator,
  travel: { x: number; y: number } = TRAVEL,
): Promise<void> {
  const box = await viewportBox(control);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + travel.x,
    box.y + box.height / 2 + travel.y,
    { steps: 8 },
  );
  await page.mouse.up();
}

async function selectedText(page: Page): Promise<string> {
  return await page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/**
 * Drag across the element the way a selection starts. `fromX` is where the
 * press lands: 1px for a strip, so it starts in the gap before the first
 * control, and further in for a field whose left padding holds an icon.
 */
async function sweep(
  page: Page,
  element: Locator,
  fromX: number = 1,
): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const box = await viewportBox(element);

  await page.mouse.move(box.x + fromX, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
}

/**
 * The fixture is taller than the frame, and raw mouse coordinates are not
 * scrolled for us the way `click()` scrolls: a press below the fold would land
 * on nothing and every assertion here would pass for the wrong reason.
 */
async function viewportBox(
  element: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await element.scrollIntoViewIfNeeded();
  await expect(element).toBeInViewport();

  return (await element.boundingBox())!;
}
