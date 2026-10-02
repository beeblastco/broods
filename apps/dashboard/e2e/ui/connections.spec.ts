import { expect, test } from "@playwright/test";

test("lists each connection type, signed in or ready to connect", async ({
  page,
}) => {
  await page.goto("/ui-gallery?tab=connections");
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  const [connected, empty] = [
    page.locator("section").nth(0),
    page.locator("section").nth(1),
  ];

  await expect(connected.getByText("ChatGPT plan")).toBeVisible();
  await expect(
    connected.getByText("Signed in as owner@example.com"),
  ).toBeVisible();
  await expect(
    connected.getByRole("button", { name: "Disconnect ChatGPT plan" }),
  ).toBeVisible();
  await expect(
    connected.getByRole("button", { name: "Connect", exact: true }),
  ).toHaveCount(0);

  await empty.getByRole("button", { name: "Connect", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Connect ChatGPT plan")).toBeVisible();
  await expect(dialog.getByText("broods connect chatgpt")).toBeVisible();
});
