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
  await expect(menu.getByRole("menuitem", { name: /tracy/ })).toBeDisabled();
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
