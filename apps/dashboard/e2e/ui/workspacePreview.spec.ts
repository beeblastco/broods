import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openGallery } from "../lib/gallery";

/**
 * The file preview under the workspace tree, against the fixture in
 * `app/ui-gallery/WorkspaceFilesStandIn`: the selected file shows in one
 * transient tab, Enter keeps it open, and the split between tree and preview
 * can be dragged and is kept.
 */

async function openExplorer(page: Page, fixture: string): Promise<Locator> {
  await openGallery(page, "workspace-files");

  return page.locator(`[data-fixture="${fixture}"]`);
}

function row(scope: Locator, name: string): Locator {
  return scope.getByRole("treeitem", { name: name, exact: true });
}

function tab(scope: Locator, name: string): Locator {
  return scope.getByRole("tab", { name: name, exact: true });
}

function panel(scope: Locator): Locator {
  return scope.getByRole("tabpanel");
}

test("selecting previews a file in one tab, Enter keeps it open beside the next", async ({
  page,
}) => {
  const writer = await openExplorer(page, "files-writer");
  await expect(writer.getByRole("tablist")).toHaveCount(0);

  await row(writer, "agent.ts").click();
  await expect(tab(writer, "agent.ts")).not.toHaveAttribute("data-pinned");
  await expect(panel(writer)).toContainText("defineAgent");

  // Selection moves the transient tab; nothing piles up.
  await page.keyboard.press("ArrowDown");
  await expect(writer.getByRole("tab")).toHaveCount(1);
  await expect(tab(writer, "assets.zip")).toBeVisible();

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(tab(writer, "agent.ts")).toHaveAttribute("data-pinned", "true");

  await row(writer, "notes.txt").click();
  await expect(writer.getByRole("tab")).toHaveCount(2);
  await expect(tab(writer, "notes.txt")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel(writer)).toContainText("refund policy");

  await tab(writer, "agent.ts").click();
  await expect(panel(writer)).toContainText("defineAgent");

  // Double-clicking the transient tab keeps it open too.
  await tab(writer, "notes.txt").dblclick();
  await expect(tab(writer, "notes.txt")).toHaveAttribute("data-pinned", "true");

  await writer.getByRole("button", { name: "Close agent.ts" }).click();
  await expect(tab(writer, "agent.ts")).toHaveCount(0);
  await expect(tab(writer, "notes.txt")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // A folder selection drops the transient tab, pinned ones stay.
  await row(writer, "docs").click();
  await expect(writer.getByRole("tab")).toHaveCount(1);
});

test("Markdown previews rendered with its source a click away", async ({
  page,
}) => {
  const writer = await openExplorer(page, "files-writer");
  await row(writer, "docs").click();
  await row(writer, "guide.md").click();

  await expect(
    panel(writer).getByRole("heading", { name: "Getting started" }),
  ).toBeVisible();
  await panel(writer).getByRole("button", { name: "source" }).click();
  await expect(panel(writer).locator(".cm-content")).toContainText(
    "# Getting started",
  );
});

test("images show, and large or binary files offer Download instead", async ({
  page,
}) => {
  const writer = await openExplorer(page, "files-writer");

  await row(writer, "logo.svg").click();
  await expect(
    panel(writer).getByRole("img", { name: "logo.svg" }),
  ).toBeVisible();

  await row(writer, "build.log").click();
  await expect(panel(writer)).toContainText(
    "Files over 512 KiB are not previewed.",
  );
  await panel(writer)
    .getByRole("button", { name: "Download", exact: true })
    .click();
  await expect(writer.locator("[data-files-log] li")).toHaveText([
    "download build.log",
  ]);

  await row(writer, "assets.zip").click();
  await expect(panel(writer)).toContainText("No preview for this file type.");
});

test("a pinned tab follows its file through a rename", async ({ page }) => {
  const writer = await openExplorer(page, "files-writer");
  await row(writer, "notes.txt").click();
  await page.keyboard.press("Enter");

  await page.keyboard.press("F2");
  await writer
    .getByRole("textbox", { name: "Rename notes.txt" })
    .fill("todo.txt");
  await page.keyboard.press("Enter");

  await expect(tab(writer, "todo.txt")).toHaveAttribute("data-pinned", "true");
  await expect(tab(writer, "notes.txt")).toHaveCount(0);
});

test("a member can preview files", async ({ page }) => {
  const member = await openExplorer(page, "files-member");
  await row(member, "README.md").click();

  await expect(
    panel(member).getByRole("heading", { name: "Support docs" }),
  ).toBeVisible();
});

test("the split resizes by keyboard and is kept across a reload", async ({
  page,
}) => {
  const writer = await openExplorer(page, "files-writer");
  await row(writer, "agent.ts").click();
  const handle = writer.getByRole("separator", {
    name: "Resize the file preview",
  });
  const before = Number(await handle.getAttribute("aria-valuenow"));

  await handle.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => Number(await handle.getAttribute("aria-valuenow")))
    .toBeGreaterThan(before);
  const resized = Number(await handle.getAttribute("aria-valuenow"));

  await page.reload();
  await page.locator('main[data-hydrated="true"]').waitFor();
  await row(writer, "agent.ts").click();
  await expect
    .poll(async () => Number(await handle.getAttribute("aria-valuenow")))
    .toBe(resized);
});
