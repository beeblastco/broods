import { expect, test } from "@playwright/test";

test("lists connections and the command that adds each type", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=connections");
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();

  for (const name of ["chatgpt", "gmail", "outlook"]) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Disconnect gmail" }),
  ).toBeVisible();
  await expect(page.getByText("broods connect chatgpt")).toBeVisible();
});
