import { expect, test } from "@playwright/test";
import { openGallery } from "../lib/gallery";

/**
 * Right-click on a card used to open "Add service" unless the card happened to
 * have a chip action. Every card now gets its own menu: a row per link, its
 * group, and Delete, with what code owns listed but locked.
 */
test("a card's menu lists its links, locks the code-managed ones, and offers its group", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-node-menu"]');
  await fixture.scrollIntoViewIfNeeded();

  const coder = fixture.getByTestId("menu-target-coder");
  await coder.click({ button: "right" });
  const menu = page.getByRole("menu");
  // The lock icon is hidden from a screen reader, so the row's name carries the reason.
  await expect(
    menu.getByRole("menuitem", { name: /tracy.*managed through code/ }),
  ).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: /Delete/ })).toBeDisabled();
  await menu.getByRole("menuitem", { name: /reviewer/ }).click();
  await expect(coder).toContainText(
    "unlink subagent:coder-right-reviewer-left",
  );

  const handbook = fixture.getByTestId("menu-target-handbook");
  await handbook.click({ button: "right" });
  await expect(menu.getByText(/^Group · /)).toBeVisible();
  await menu.getByRole("menuitem", { name: "Pull out of group" }).click();
  await expect(handbook).toContainText("group handbook");
});

/**
 * A read-only workspace mounts nowhere, so it has no edge to carry its mount
 * word. Its menu is the only way back off read-only, and it renames cards too.
 */
test("a workspace's menu renames the card and lists where it can mount", async ({
  page,
}) => {
  await openGallery(page);
  const fixture = page.locator('[data-fixture="canvas-node-menu"]');
  await fixture.scrollIntoViewIfNeeded();

  const handbook = fixture.getByTestId("menu-target-handbook");
  await handbook.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByText("Mounts on")).toBeVisible();
  await menu.getByRole("menuitem", { name: "No sandbox, read-only" }).click();
  await expect(handbook).toContainText("mount readonly");

  await handbook.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Rename" }).click();
  await expect(handbook).toContainText("rename handbook");
});
