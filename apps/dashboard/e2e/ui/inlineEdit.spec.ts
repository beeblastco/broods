import { expect, test, type Locator, type Page } from "@playwright/test";
import { openGallery } from "../lib/gallery";

/**
 * Renames in place and links that go on the press, against the fixture in
 * `app/ui-gallery/InlineEditStandIn`. Every committed rename lands in
 * `[data-renamed]`; `?opened=` names the link that was followed.
 */

function fixture(page: Page, name: string): Locator {
  return page.locator(`[data-fixture="${name}"]`);
}

function renamed(page: Page): Locator {
  return page.locator("[data-renamed-entry]");
}

/** Whether the field's whole text is selected, so typing replaces it. */
async function selectsAll(field: Locator): Promise<boolean> {
  return field.evaluate(
    (input: HTMLInputElement) =>
      input.selectionStart === 0 && input.selectionEnd === input.value.length,
  );
}

test.describe("the inline edit field", () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, "inline-edit");
  });

  test("opens with the name selected; Enter commits it trimmed and hands focus back", async ({
    page,
  }) => {
    const section = fixture(page, "inline-edit");
    const trigger = section.getByRole("button", { name: "Rename" });
    await trigger.click();

    const field = section.getByRole("textbox", { name: "Agent name" });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Support bot");
    expect(await selectsAll(field)).toBe(true);

    await page.keyboard.type("  Triage bot  ");
    await page.keyboard.press("Enter");

    await expect(field).toHaveCount(0);
    await expect(section.locator("[data-name]")).toHaveText("Triage bot");
    await expect(trigger).toBeFocused();
    await expect(renamed(page)).toHaveText(["field Triage bot"]);
  });

  test("Escape cancels and hands focus back", async ({ page }) => {
    const section = fixture(page, "inline-edit");
    const trigger = section.getByRole("button", { name: "Rename" });
    await trigger.click();
    await page.keyboard.type("Billing bot");
    await page.keyboard.press("Escape");

    await expect(
      section.getByRole("textbox", { name: "Agent name" }),
    ).toHaveCount(0);
    await expect(section.locator("[data-name]")).toHaveText("Support bot");
    await expect(trigger).toBeFocused();
    await expect(renamed(page)).toHaveCount(0);
  });

  test("leaving the field commits it, and focus stays where it went", async ({
    page,
  }) => {
    const section = fixture(page, "inline-edit");
    await section.getByRole("button", { name: "Rename" }).click();
    await page.keyboard.type("Billing bot");

    const elsewhere = section.getByRole("textbox", { name: "Somewhere else" });
    await elsewhere.click();

    await expect(
      section.getByRole("textbox", { name: "Agent name" }),
    ).toHaveCount(0);
    await expect(section.locator("[data-name]")).toHaveText("Billing bot");
    await expect(elsewhere).toBeFocused();
    await expect(renamed(page)).toHaveText(["field Billing bot"]);
  });

  test("a blank name is refused and the field stays open; leaving it keeps the old name", async ({
    page,
  }) => {
    const section = fixture(page, "inline-edit");
    await section.getByRole("button", { name: "Rename" }).click();
    const field = section.getByRole("textbox", { name: "Agent name" });
    await field.fill("   ");
    await page.keyboard.press("Enter");

    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.type("x");
    await expect(field).not.toHaveAttribute("aria-invalid", "true");

    await field.fill("");
    await section.getByRole("textbox", { name: "Somewhere else" }).click();
    await expect(field).toHaveCount(0);
    await expect(section.locator("[data-name]")).toHaveText("Support bot");
    await expect(renamed(page)).toHaveCount(0);
  });

  test("committing the same name again saves nothing", async ({ page }) => {
    const section = fixture(page, "inline-edit");
    const trigger = section.getByRole("button", { name: "Rename" });
    await trigger.click();
    await page.keyboard.type(" Support bot ");
    await page.keyboard.press("Enter");

    await expect(trigger).toBeFocused();
    await expect(renamed(page)).toHaveCount(0);
  });
});

test.describe("a canvas card", () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, "inline-edit");
  });

  test("renames in place on a double-click of its name; Enter hands focus back to the card", async ({
    page,
  }) => {
    const section = fixture(page, "inline-edit-card");
    const card = section.locator(".react-flow__node");
    await card.getByText("triage", { exact: true }).dblclick();

    const field = section.getByRole("textbox", { name: "Rename triage" });
    await expect(field).toBeFocused();
    expect(await selectsAll(field)).toBe(true);

    // A press and drag in the field selects its text and leaves the card put.
    const before = await card.boundingBox();
    const box = await field.boundingBox();
    if (!before || !box) throw new Error("The card or its field has no box.");
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    expect(await card.boundingBox()).toEqual(before);
    await expect(field).toBeFocused();

    await field.fill("triage-v2");
    await page.keyboard.press("Enter");

    await expect(field).toHaveCount(0);
    await expect(card).toContainText("triage-v2");
    await expect(card).toBeFocused();
    await expect(renamed(page)).toHaveText(["card triage-v2"]);
  });

  test("the field keeps the card's height while it is open", async ({
    page,
  }) => {
    const section = fixture(page, "inline-edit-card");
    const header = section.locator('[data-slot="card-header"]');
    const closed = await header.boundingBox();
    await section.getByText("triage", { exact: true }).dblclick();
    await expect(
      section.getByRole("textbox", { name: "Rename triage" }),
    ).toBeFocused();

    expect((await header.boundingBox())?.height).toBe(closed?.height);
  });

  test("Escape keeps the old name", async ({ page }) => {
    const section = fixture(page, "inline-edit-card");
    await section.getByText("triage", { exact: true }).dblclick();
    await page.keyboard.type("scratch");
    await page.keyboard.press("Escape");

    await expect(section.locator(".react-flow__node")).toContainText("triage");
    await expect(renamed(page)).toHaveCount(0);
  });
});

test.describe("a project card", () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, "inline-edit");
  });

  test("renames from its pencil, and Enter hands focus back to the pencil", async ({
    page,
  }) => {
    const section = fixture(page, "inline-edit-project");
    await section.getByRole("button", { name: "Rename alpha" }).click();
    const field = section.getByRole("textbox", { name: "Rename alpha" });
    await expect(field).toBeFocused();

    await page.keyboard.type("alpha-2");
    await page.keyboard.press("Enter");

    await expect(
      section.getByRole("button", { name: "Open alpha-2" }),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Rename alpha-2" }),
    ).toBeFocused();
    await expect(renamed(page)).toHaveText(["project alpha-2"]);
    // Renaming opened nothing.
    await expect(page).not.toHaveURL(/opened=/);
  });

  test("a refused rename goes back to the old name and says why", async ({
    page,
  }) => {
    const section = fixture(page, "inline-edit-project");
    await section.getByRole("button", { name: "Rename beta" }).click();
    await page.keyboard.type("taken");
    await page.keyboard.press("Enter");

    await expect(section.getByText("Name already taken.")).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Open beta" }),
    ).toBeVisible();
  });

  test("a reader has no pencil", async ({ page }) => {
    const section = fixture(page, "inline-edit-project");
    await expect(
      section.getByRole("button", { name: "Open gamma" }),
    ).toBeVisible();
    await expect(
      section.getByRole("button", { name: "Rename gamma" }),
    ).toHaveCount(0);
  });

  test("opens on the press, before the release", async ({ page }) => {
    const section = fixture(page, "inline-edit-project");
    await pressAndHold(
      page,
      section.getByRole("button", { name: "Open alpha" }),
    );
    await expect(page).toHaveURL(/opened=alpha/);
    await page.mouse.up();
  });
});

test.describe("links on the shared handlers", () => {
  test.beforeEach(async ({ page }) => {
    await openGallery(page, "inline-edit");
  });

  test("a plain press follows a link before the release, and only once", async ({
    page,
  }) => {
    const links = fixture(page, "press-links");
    await pressAndHold(page, links.getByRole("link", { name: "Open by link" }));
    await expect(page).toHaveURL(/opened=link/);
    await expect(links.locator("[data-opened]")).toHaveText("link");
    await page.mouse.up();

    // The release does not push a second entry: one Back is the page before.
    await page.goBack();
    await expect(page).not.toHaveURL(/opened=/);
  });

  test("a control that is not a link goes on the press, and on Enter", async ({
    page,
  }) => {
    const links = fixture(page, "press-links");
    const button = links.getByRole("button", { name: "Open by button" });
    await pressAndHold(page, button);
    await expect(page).toHaveURL(/opened=button/);
    await page.mouse.up();

    await links.getByRole("link", { name: "Reset" }).click();
    await expect(page).not.toHaveURL(/opened=/);
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/opened=button/);
  });

  test("a menu item picked by pressing its trigger and releasing on it still goes", async ({
    page,
  }) => {
    const links = fixture(page, "press-links");
    await pressAndHold(page, links.getByRole("button", { name: "Projects" }));
    const item = page.getByRole("menuitem", { name: "Open by menu" });
    await expect(item).toBeVisible();
    // Past the 200 ms in which Base UI ignores a release on an item.
    await page.waitForTimeout(300);
    const box = await item.boundingBox();
    if (!box) throw new Error("The menu item has no box.");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 4,
    });
    await page.mouse.up();
    await expect(page).toHaveURL(/opened=menu/);
  });

  test("the current link waits for the click, which still resets the page", async ({
    page,
  }) => {
    const links = fixture(page, "press-links");
    await links.getByRole("link", { name: "Open by link" }).click();
    await expect(page).toHaveURL(/opened=link/);

    await pressAndHold(page, links.getByRole("link", { name: "Reset" }));
    // Held: nothing yet. Released: the click goes there.
    await expect(links.locator("[data-opened]")).toHaveText("link");
    await page.mouse.up();
    await expect(page).not.toHaveURL(/opened=/);
  });

  test("a modified click is left to the browser", async ({ page, context }) => {
    const links = fixture(page, "press-links");
    const opened = context.waitForEvent("page");
    await links
      .getByRole("link", { name: "Open by link" })
      .click({ modifiers: ["ControlOrMeta"] });
    await (await opened).close();

    await expect(links.locator("[data-opened]")).toHaveText("none");
    await expect(page).not.toHaveURL(/opened=/);
  });
});

/** Moves onto `target` and presses the left button without releasing it. */
async function pressAndHold(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("The target has no box.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}
