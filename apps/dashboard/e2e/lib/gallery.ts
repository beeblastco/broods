import type { Page } from "@playwright/test";

/**
 * Open the fixture and wait until React owns it, so the first hover or click
 * lands on a listener rather than on the server markup.
 */
export async function openGallery(page: Page, tab?: string): Promise<void> {
  await page.goto(tab ? `/ui-gallery?tab=${tab}` : "/ui-gallery");
  await page.locator('main[data-hydrated="true"]').waitFor();
}
