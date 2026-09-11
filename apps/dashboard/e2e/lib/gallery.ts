import type { Page } from "@playwright/test";

/**
 * Open the fixture and wait until React owns it, so the first hover or click
 * lands on a listener rather than on the server markup.
 */
export async function openGallery(page: Page): Promise<void> {
  await page.goto("/ui-gallery");
  await page.locator('main[data-hydrated="true"]').waitFor();
}
