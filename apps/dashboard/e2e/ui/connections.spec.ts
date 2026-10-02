import { expect, test } from "@playwright/test";

test("lists connections and the command that adds each type", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=connections");
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();

  for (const label of ["ChatGPT plan", "Google", "Microsoft"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Disconnect Google" }),
  ).toBeVisible();
  await expect(page.getByText("broods connect google")).toBeVisible();
});
