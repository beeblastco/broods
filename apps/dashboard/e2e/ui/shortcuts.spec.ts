import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// Not [role=dialog]: that also catches Next's dev error overlay.
const DIALOG = '[data-slot="dialog-content"]';

async function openSurfaces(page: Page): Promise<void> {
  await page.goto("/ui-gallery?tab=shortcuts");
  await page.locator('main[data-hydrated="true"]').waitFor();
}

function rows(page: Page): Locator {
  return page.locator(`${DIALOG} [cmdk-item]`);
}

function ran(page: Page): Locator {
  return page.locator("[data-ran-entry]");
}

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

test("a palette chunk that fails to load leaves a notice, not a broken page", async ({
  page,
}) => {
  let loaded = false;
  page.on("load", () => {
    loaded = true;
  });
  // Chunk names are hashed; every chunk fetched after the load event is a lazy one.
  await page.route(/\/_next\/static\/chunks\//, (route) =>
    loaded ? route.abort() : route.fallback(),
  );
  await openSurfaces(page);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(
    page.getByRole("alert").filter({ hasText: "Couldn't load search" }),
  ).toBeVisible();
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await expect(page.locator(DIALOG)).toHaveCount(0);
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

test("a row that leads to a page starts it once highlighted, by key or pointer", async ({
  page,
}) => {
  await openSurfaces(page);
  const warmed = page.locator("[data-warmed]");
  await page.keyboard.press("ControlOrMeta+k");

  await expect(warmed).toHaveText("/p/scheduler");
  await page.keyboard.press("ArrowDown");
  await expect(warmed).toHaveText("/p/dashboard");

  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(2)).toHaveAttribute("data-selected", "true");
  await expect(warmed).toHaveText("/p/dashboard");

  await rows(page).filter({ hasText: "production" }).hover();
  await expect(warmed).toHaveText("/p?stage=s2");
});

test("the palette lists the bindings the page has claimed, and drops them when it unmounts", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("tidy");
  await expect(rows(page).first()).toContainText("Tidy up");

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
  await expect(ran(page)).toHaveCount(1);
});

test("Escape closes the panel from a text field, unless the field spends it", async ({
  page,
}) => {
  await openSurfaces(page);

  await page.locator('[data-fixture="editable"] input').click();
  await page.keyboard.press("Escape");
  await expect(ran(page)).toHaveText(["command panel.toggle"]);

  await page.locator('[data-fixture="consumes-escape"] input').click();
  await page.keyboard.press("Escape");
  await expect(ran(page)).toHaveCount(1);

  await page.locator('[data-fixture="editable"] input').evaluate((field) =>
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        isComposing: true,
        key: "Escape",
      }),
    ),
  );
  await expect(ran(page)).toHaveCount(1);
});

test("+ types in a field instead of zooming the canvas behind it", async ({
  page,
}) => {
  await openSurfaces(page);

  // Bare `+` is a canvas binding and also the separator in a combo string.
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

  await expect(ran(page)).toHaveCount(0);

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
  await expect(ran(page)).toHaveText(["navigate /p/scheduler"]);
});

test("a write waits in the canvas bar, shows its before and after there, and applies once", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+j");

  const dock = page.getByRole("complementary");
  await dock
    .getByPlaceholder("Ask, or describe a change...")
    .fill("pause nightly-digest");
  await page.keyboard.press("Enter");

  await expect(dock.locator("[data-apply-status]")).toHaveText(
    "Proposed. Review it at the top of the canvas.",
  );
  await expect(dock.getByRole("button", { name: "Apply" })).toHaveCount(0);
  await expect(dock.locator("[data-plan-change]")).toHaveCount(0);

  const bar = page.locator("[data-apply-bar]");
  await expect(bar).toContainText("Pause nightly-digest");
  await bar.locator("[data-apply-code]").click();
  await expect(bar.locator("[data-plan-change]")).toContainText("active");
  await expect(bar.locator("[data-plan-change]")).toContainText("paused");
  await expect(ran(page)).toHaveCount(0);

  await bar.getByRole("button", { name: "Apply" }).click();
  await expect(ran(page)).toHaveText(["setCronStatus c1 paused"]);
  await expect(bar).toHaveCount(0);
  await expect(dock.locator("[data-apply-status]")).toHaveText("Applied.");
});

test("a waiting write stays in the bar with the dock closed", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+j");
  const dock = page.getByRole("complementary");
  await dock
    .getByPlaceholder("Ask, or describe a change...")
    .fill("pause nightly-digest");
  await page.keyboard.press("Enter");

  await page.keyboard.press("ControlOrMeta+j");
  await expect(dock).toHaveCount(0);
  const bar = page.locator("[data-apply-bar]");
  await expect(bar).toHaveAttribute("data-apply-bar", "proposed");
  await bar.getByRole("button", { name: "Apply" }).click();
  await expect(ran(page)).toHaveText(["setCronStatus c1 paused"]);
});

test("a discarded write leaves the bar, never runs, and the chat says so", async ({
  page,
}) => {
  await openSurfaces(page);
  await page.keyboard.press("ControlOrMeta+j");
  const dock = page.getByRole("complementary");
  await dock
    .getByPlaceholder("Ask, or describe a change...")
    .fill("pause nightly-digest");
  await page.keyboard.press("Enter");

  const bar = page.locator("[data-apply-bar]");
  await bar.getByRole("button", { name: "Discard" }).click();
  await expect(bar).toHaveCount(0);
  await expect(ran(page)).toHaveCount(0);
  await expect(dock.locator("[data-apply-status]")).toHaveText(
    "Discarded. Nothing was changed.",
  );
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

  const ask = rows(page).filter({ hasText: "Ask Broods agent:" });
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
