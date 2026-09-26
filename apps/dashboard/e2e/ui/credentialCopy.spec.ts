import { expect, test } from "@playwright/test";

const GALLERY_URL = "/ui-gallery?tab=credential-copy";

test("copies a masked credential only after an active click succeeds", async ({
  page,
}) => {
  await page.addInitScript((): void => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string): Promise<void> => {
          document.documentElement.dataset.clipboardValue = value;
        },
      },
    });
  });
  await page.goto(GALLERY_URL);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await expect(page.getByRole("textbox")).not.toHaveValue("clipboard fixture");
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-clipboard-value",
  );
  await page.getByRole("button", { name: "Copy", exact: true }).first().click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-clipboard-value",
    "clipboard fixture",
  );
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
});

test("does not report a denied clipboard write as successful", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error): void => {
    errors.push(error.message);
  });
  await page.addInitScript((): void => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (): Promise<void> => {
          throw new DOMException("Denied", "NotAllowedError");
        },
      },
    });
  });
  await page.goto(GALLERY_URL);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await page.getByRole("button", { name: "Copy", exact: true }).first().click();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("refuses credential copying without transient user activation", async ({
  page,
}) => {
  await page.addInitScript((): void => {
    Object.defineProperty(navigator, "userActivation", {
      value: { isActive: false },
    });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (): Promise<void> => {
          document.documentElement.dataset.clipboardValue = "unexpected";
        },
      },
    });
  });
  await page.goto(GALLERY_URL);
  await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
  await page.getByRole("button", { name: "Copy", exact: true }).first().click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-clipboard-value",
  );
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toHaveCount(0);
});
