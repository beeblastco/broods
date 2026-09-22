import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * The keyboard surfaces against the fixture in `app/ui-gallery/ShortcutsStandIn`.
 * The dispatcher, the palette ranking and the plan rules are the real ones;
 * every action they take lands in `[data-ran]`.
 */

// The app's own dialogs. Plain [role=dialog] would also catch Next's dev error
// overlay, which is exactly the thing a failing spec needs to stay clear of.
const DIALOG = '[data-slot="dialog-content"]';

async function openSurfaces(page: Page): Promise<void> {
  await page.goto("/ui-gallery?tab=shortcuts");
  await page.locator('main[data-hydrated="true"]').waitFor();
}

/** What the palette is showing, row by row. */
function rows(page: Page): Locator {
  return page.locator(`${DIALOG} [cmdk-item]`);
}

/** Everything the surfaces have done, oldest first. */
function ran(page: Page): Locator {
  return page.locator("[data-ran-entry]");
}

/**
 * Both of these shipped once and neither broke a visible assertion: the ⌘/Ctrl
 * glyph differed between the server and the client, and `useShortcut` depended
 * on a context value that changes on every registration, so each new binding
 * re-registered every other one. They only ever showed up in the console.
 */
test("registering bindings and opening the surfaces logs nothing broken", async ({
  page,
}) => {
  const complaints: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (
      /Maximum update depth|Hydration failed|hydration-mismatch/i.test(text)
    ) {
      complaints.push(text);
    }
  });
  page.on("pageerror", (error) => complaints.push(error.message));

  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+j");
  await page.keyboard.press("?");

  expect(complaints).toEqual([]);
});

test("the palette opens on its key and on its trigger, and Escape closes it", async ({
  page,
}) => {
  await openSurfaces(page);
  await expect(page.locator(DIALOG)).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(DIALOG)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(DIALOG)).toHaveCount(0);

  await page.locator("[data-palette-trigger]").click();
  await expect(page.locator(DIALOG)).toBeVisible();
});

test("typing ranks real rows under their headings and Enter runs the top one", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("triage");

  await expect(page.locator(`${DIALOG} [cmdk-group-heading]`)).toHaveText([
    "Nodes",
    "Ask",
  ]);
  await expect(rows(page).first()).toContainText("triage");

  await page.keyboard.press("Enter");
  await expect(page.locator(DIALOG)).toHaveCount(0);
  await expect(ran(page)).toHaveText(["openNode 7"]);
});

test("a keyword finds a page the title never mentions", async ({ page }) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("traces");

  await expect(rows(page).first()).toContainText("Dashboard");
  await page.keyboard.press("Enter");
  await expect(ran(page)).toHaveText(["navigate /p/dashboard"]);
});

test("the palette lists the bindings the page has claimed, and drops them when it unmounts", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("tidy");
  await expect(rows(page).first()).toContainText("Tidy up");

  // Selecting the row runs the same handler the key runs.
  await page.keyboard.press("Enter");
  await expect(ran(page)).toHaveText(["command canvas.tidy"]);

  await page.locator("[data-drop-canvas]").click();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("tidy");
  await expect(rows(page).filter({ hasText: "Tidy up" })).toHaveCount(0);
});

test("a bare key is a command outside a text field and typing inside one", async ({
  page,
}) => {
  await openSurfaces(page);

  await page.keyboard.press("t");
  await expect(ran(page)).toHaveText(["command canvas.tidy"]);

  const field = page.locator('[data-fixture="editable"] input');
  await field.click();
  await page.keyboard.type("tidy");
  await expect(field).toHaveValue("tidy");
  // Still the one entry from before: nothing fired while typing.
  await expect(ran(page)).toHaveCount(1);
});

test("+ types in a field instead of zooming the canvas behind it", async ({
  page,
}) => {
  await openSurfaces(page);

  // Bare `+` is a canvas binding, and `+` is also the separator in a combo
  // string, so reading the combo text called this a chord and skipped the
  // guard that keeps a bare key out of a text field.
  const field = page.locator('[data-fixture="editable"] input');
  await field.click();
  await page.keyboard.type("a+b");

  await expect(field).toHaveValue("a+b");
  await expect(ran(page)).toHaveCount(0);
});

test("Enter activates a focused button rather than the binding behind it", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.locator("[data-drop-canvas]").focus();
  await page.keyboard.press("Enter");

  // The canvas binds bare `enter` to rename. Cancelling the press would take
  // Enter away from every button and link on the page.
  await expect(ran(page)).toHaveCount(0);

  // The button did what it is for, so the press reached it.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("tidy");
  await expect(rows(page).filter({ hasText: "Tidy up" })).toHaveCount(0);
});

test("the ? overlay lists every binding and dims what no one has claimed", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("?");

  const overlay = page.locator(DIALOG);
  await expect(
    overlay.getByRole("heading", { name: "Keyboard shortcuts" }),
  ).toBeVisible();

  // Claimed by the fixture; the side panel's bindings are claimed by nobody.
  await expect(
    overlay.locator('[data-shortcut-row="canvas.tidy"]'),
  ).toHaveAttribute("data-live", "true");
  await expect(
    overlay.locator('[data-shortcut-row="panel.tab"]'),
  ).toHaveAttribute("data-live", "false");
});

test("the dock opens on its key and answers an ask it can resolve", async ({
  page,
}) => {
  await openSurfaces(page);
  const dock = page.getByRole("complementary");
  await expect(dock).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+j");
  await expect(dock).toBeVisible();

  await dock
    .getByPlaceholder("Ask, or describe a change...")
    .fill("go to scheduler");
  await page.keyboard.press("Enter");

  await expect(dock.locator("[data-plan-step]")).toHaveText([
    "Go to Scheduler",
  ]);
  // Navigation is reversible, so it runs without waiting for a press.
  await expect(ran(page)).toHaveText(["navigate /p/scheduler"]);
});

test("a write shows its before and after and waits for the press", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+j");

  const dock = page.getByRole("complementary");
  await dock
    .getByPlaceholder("Ask, or describe a change...")
    .fill("pause nightly-digest");
  await page.keyboard.press("Enter");

  await expect(dock.locator("[data-plan-step]")).toHaveText([
    "Pause nightly-digest",
  ]);
  await expect(dock.locator("[data-plan-change]")).toContainText("active");
  await expect(dock.locator("[data-plan-change]")).toContainText("paused");
  // Nothing has run yet: the diff is the approval.
  await expect(ran(page)).toHaveCount(0);

  await dock.getByRole("button", { name: "Apply" }).click();
  await expect(ran(page)).toHaveText(["setCronStatus c1 paused"]);
  await expect(dock.getByRole("button", { name: "Apply" })).toHaveCount(0);
});

test("a deploy is refused with a reason and no button to do it anyway", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+j");

  const dock = page.getByRole("complementary");
  await dock
    .getByPlaceholder("Ask, or describe a change...")
    .fill("deploy triage to production");
  await page.keyboard.press("Enter");

  await expect(dock.locator("[data-plan-step]")).toHaveText([
    "Cannot deploy from here",
  ]);
  await expect(dock.getByRole("button", { name: "Apply" })).toHaveCount(0);
  await expect(ran(page)).toHaveCount(0);
});

test("the palette hands an unmatched query to the dock instead of guessing", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("why does triage keep failing");

  const ask = rows(page).filter({ hasText: "Ask Broods:" });
  await expect(ask).toHaveCount(1);
  await ask.click();

  const dock = page.getByRole("complementary");
  await expect(dock).toBeVisible();
  await expect(
    dock.getByText("why does triage keep failing", { exact: true }),
  ).toBeVisible();
  await expect(dock.locator("[data-plan-step]")).toHaveCount(0);
  await expect(ran(page)).toHaveCount(0);
});

test("the dock keeps its thread while the page underneath carries on", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+j");

  const dock = page.getByRole("complementary");
  await dock
    .getByPlaceholder("Ask, or describe a change...")
    .fill("open triage");
  await page.keyboard.press("Enter");
  await expect(ran(page)).toHaveText(["openNode 7"]);

  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("Escape");

  await expect(dock.locator("[data-plan-step]")).toHaveText(["Open triage"]);
});
