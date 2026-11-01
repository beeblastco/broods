import { expect, test, type Locator, type Page } from "@playwright/test";
import { openGallery } from "../lib/gallery";

const CONTROLS = [
  { role: "button", name: "Deploy the stage" },
  { role: "tab", name: "Config" },
  { role: "combobox", name: "Press filter" },
  { role: "link", name: "Architecture" },
] as const;

const TRAVEL = { x: 8, y: 4 };

// Far enough to clear Chromium's native drag threshold.
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
    .getByRole("textbox", { name: "Search" });

  await search.fill("timeout");
  await sweep(page, search);

  // An input's selection is not in the document selection: read it off the element.
  const selected = await search.evaluate((element: HTMLInputElement) =>
    element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0),
  );
  expect(selected).toBe("timeout");
});

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

async function sweep(page: Page, element: Locator): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const box = await viewportBox(element);

  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
}

// Raw mouse coordinates do not scroll like `click()`: a press below the fold hits nothing
// and every assertion here would pass for the wrong reason.
async function viewportBox(
  element: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  await element.scrollIntoViewIfNeeded();
  await expect(element).toBeInViewport();

  return (await element.boundingBox())!;
}
