import { expect, test, type Locator, type Page } from "@playwright/test";

test("the terminal fills the dock and draws in a real monospace font", async ({
  page,
}) => {
  await openTerminal(page);

  // xterm sizes its cells on a canvas, where var() does not resolve: handed
  // the font stack as a variable, it measures a fallback font and pads every
  // glyph of the real one with letter spacing to fill the cell.
  const rows = page.locator(".xterm-rows");
  await expect(rows).toHaveCount(1);
  const spacing = await rows.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).letterSpacing),
  );
  expect(Math.abs(spacing)).toBeLessThan(0.5);
});

test("the session list opens, closes and hides shells", async ({ page }) => {
  await openTerminal(page);

  const sessions = page.getByRole("navigation", { name: "Open sessions" });
  await expect(sessionButton(page, "Shell 1")).toBeVisible();
  await sessions.getByRole("button", { name: "New shell on browser" }).click();
  await expect(sessionButton(page, "Shell 2")).toBeVisible();

  // Every session has its own close.
  await sessions
    .getByRole("button", { name: "Close Shell 2 on browser" })
    .click();
  await expect(sessionButton(page, "Shell 2")).toHaveCount(0);

  // Hiding keeps the shells; the backtick brings the dock back.
  await sessions.getByRole("button", { name: "Hide the dock" }).click();
  await expect(sessions).toBeHidden();
  await page.keyboard.press("Backquote");
  await expect(sessionButton(page, "Shell 1")).toBeVisible();

  // Closing the last session closes the dock.
  await sessions
    .getByRole("button", { name: "Close Shell 1 on browser" })
    .click();
  await expect(sessions).toHaveCount(0);
});

test("hiding the dock hands focus back to the Terminal button", async ({
  page,
}) => {
  await openTerminal(page);
  await page
    .getByRole("navigation", { name: "Open sessions" })
    .getByRole("button", { name: "Hide the dock" })
    .click();
  await expect(
    page.getByRole("button", { name: "Terminal", exact: true }),
  ).toBeFocused();
});

test("closing a session hands focus to the next one, the last to the Terminal button", async ({
  page,
}) => {
  await openTerminal(page);
  const sessions = page.getByRole("navigation", { name: "Open sessions" });
  await sessions.getByRole("button", { name: "New shell on browser" }).click();

  await sessions
    .getByRole("button", { name: "Close Shell 1 on browser" })
    .click();
  await expect(sessionButton(page, "Shell 2")).toBeFocused();

  await sessions
    .getByRole("button", { name: "Close Shell 2 on browser" })
    .click();
  await expect(sessions).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Terminal", exact: true }),
  ).toBeFocused();
});

test("the backtick hides the dock without taking focus from outside it", async ({
  page,
}) => {
  await openTerminal(page);
  const filter = page.getByRole("button", { name: "Filter" });
  await filter.focus();
  await page.keyboard.press("Backquote");
  await expect(
    page.getByRole("navigation", { name: "Open sessions" }),
  ).toBeHidden();
  await expect(filter).toBeFocused();
});

test("on a phone the session list is one row above a full-width shell", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openTerminal(page);

  const sessions = page.getByRole("navigation", { name: "Open sessions" });
  await sessions.getByRole("button", { name: "New shell on browser" }).click();
  const list = (await sessions.boundingBox())!;
  const shell = (await page
    .getByText("Your role cannot open a shell.")
    .last()
    .boundingBox())!;
  // The list spans the dock and sits above the shell instead of beside it.
  expect(list.width).toBeGreaterThan(380);
  expect(list.y + list.height).toBeLessThanOrEqual(shell.y);
  // Every session keeps its own close, side by side on the one row.
  const first = (await sessions
    .getByRole("button", { name: "Close Shell 1 on browser" })
    .boundingBox())!;
  const second = (await sessions
    .getByRole("button", { name: "Close Shell 2 on browser" })
    .boundingBox())!;
  expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
  expect(second.x).toBeGreaterThan(first.x);
});

// Opens the gallery's sandbox stand-in, once React owns it, and its first shell.
async function openTerminal(page: Page): Promise<void> {
  await page.goto("/ui-gallery?tab=sandbox");
  await page.locator('[data-hydrated="true"]').waitFor();
  await page.getByText("browser", { exact: true }).first().click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
}

// A session's switch button in the dock's list.
function sessionButton(page: Page, name: string): Locator {
  return page
    .getByRole("navigation", { name: "Open sessions" })
    .getByRole("button", { name: `${name} on browser`, exact: true });
}
