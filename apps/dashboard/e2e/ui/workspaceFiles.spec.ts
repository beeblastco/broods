import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * The workspace file explorer by keyboard, against the fixture in
 * `app/ui-gallery/WorkspaceFilesStandIn`. The view is the real one; every
 * upload, rename and delete it asks for lands in `[data-files-log]`.
 */

// The app's own dialogs, not Next's dev error overlay.
const DIALOG = '[data-slot="dialog-content"]';

async function openExplorer(page: Page, fixture: string): Promise<Locator> {
  await page.goto("/ui-gallery?tab=workspace-files");
  await page.locator('main[data-hydrated="true"]').waitFor();

  return page.locator(`[data-fixture="${fixture}"]`);
}

function row(scope: Locator, name: string): Locator {
  return scope.getByRole("treeitem", { name: name, exact: true });
}

function log(scope: Locator): Locator {
  return scope.locator("[data-files-log] li");
}

/** Drops one file on the explorer the way a browser does: enter, over, drop. */
async function dropFile(
  page: Page,
  scope: Locator,
  name: string,
): Promise<void> {
  const dataTransfer = await page.evaluateHandle((fileName) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["hello"], fileName, { type: "text/plain" }));

    return transfer;
  }, name);
  const zone = scope.getByRole("tree");
  await zone.dispatchEvent("dragenter", { dataTransfer: dataTransfer });
  await zone.dispatchEvent("dragover", { dataTransfer: dataTransfer });
  await zone.dispatchEvent("drop", { dataTransfer: dataTransfer });
}

test("Tab enters the tree once and arrows walk, open and close folders", async ({
  page,
}) => {
  const writer = await openExplorer(page, "files-writer");
  await writer.getByRole("button", { name: "Upload folder" }).focus();
  await page.keyboard.press("Tab");

  const docs = row(writer, "docs");
  await expect(docs).toBeFocused();
  await expect(docs).toHaveAttribute("aria-expanded", "false");
  expect(await docs.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe(
    "none",
  );

  await page.keyboard.press("ArrowRight");
  await expect(docs).toHaveAttribute("aria-expanded", "true");
  await expect(docs).toBeFocused();

  await page.keyboard.press("ArrowRight");
  const api = row(writer, "api");
  await expect(api).toBeFocused();
  await expect(api).toHaveAttribute("aria-selected", "true");
  await expect(api).toHaveAttribute("aria-level", "2");

  await page.keyboard.press("ArrowDown");
  await expect(row(writer, "guide.md")).toBeFocused();

  await page.keyboard.press("ArrowLeft");
  await expect(docs).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(docs).toHaveAttribute("aria-expanded", "false");
  await expect(row(writer, "guide.md")).toHaveCount(0);

  await page.keyboard.press("End");
  await expect(row(writer, "README.md")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(docs).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(docs).toHaveAttribute("aria-expanded", "true");

  // One tab stop: Tab leaves the tree instead of walking every row and button.
  await expect(writer.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(
    1,
  );
});

test("F2 renames the focused row, Escape cancels, focus stays on the row", async ({
  page,
}) => {
  const writer = await openExplorer(page, "files-writer");
  await row(writer, "notes.txt").click();

  await page.keyboard.press("F2");
  const input = writer.getByRole("textbox", { name: "Rename notes.txt" });
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(row(writer, "notes.txt")).toBeFocused();
  await expect(log(writer)).toHaveCount(0);

  await page.keyboard.press("F2");
  await input.fill("todo.txt");
  await page.keyboard.press("Enter");
  await expect(row(writer, "todo.txt")).toBeFocused();
  await expect(row(writer, "todo.txt")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(log(writer)).toHaveText(["rename notes.txt todo.txt"]);

  // Keys typed into the input stay there: arrows do not move the selection.
  await page.keyboard.press("F2");
  await page.keyboard.press("ArrowUp");
  await expect(
    writer.getByRole("textbox", { name: "Rename todo.txt" }),
  ).toBeFocused();
});

test("Delete asks first, Escape keeps the file, confirming removes it", async ({
  page,
}) => {
  const writer = await openExplorer(page, "files-writer");
  await row(writer, "README.md").click();

  await page.keyboard.press("Delete");
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row(writer, "README.md")).toBeFocused();

  await page.keyboard.press("Delete");
  await dialog.getByRole("textbox").fill("delete README.md");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(row(writer, "README.md")).toHaveCount(0);
  await expect(log(writer)).toHaveText(["delete README.md"]);
});

test("a dropped file uploads for a writer", async ({ page }) => {
  const writer = await openExplorer(page, "files-writer");
  await dropFile(page, writer, "dropped.txt");

  await expect(row(writer, "dropped.txt")).toBeVisible();
  await expect(log(writer)).toHaveText(["upload dropped.txt"]);
});

test("a member can browse but not rename, delete or drop", async ({ page }) => {
  const member = await openExplorer(page, "files-member");
  await expect(member.getByRole("button", { name: /Upload/ })).toHaveCount(0);

  await row(member, "notes.txt").focus();
  await page.keyboard.press("ArrowDown");
  await expect(row(member, "README.md")).toBeFocused();
  await expect(row(member, "README.md")).not.toHaveAttribute(
    "aria-keyshortcuts",
  );
  await expect(
    member.getByRole("button", { name: "Delete README.md" }),
  ).toHaveCount(0);

  await page.keyboard.press("F2");
  await expect(member.getByRole("textbox")).toHaveCount(0);
  await page.keyboard.press("Delete");
  await expect(page.locator(DIALOG)).toHaveCount(0);

  await dropFile(page, member, "dropped.txt");
  await expect(member.getByText("Drop to upload")).toHaveCount(0);
  await expect(row(member, "dropped.txt")).toHaveCount(0);
  await expect(log(member)).toHaveCount(0);
});
