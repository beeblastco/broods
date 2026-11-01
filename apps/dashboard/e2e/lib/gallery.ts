import type { Page } from "@playwright/test";

// Wait for hydration, so the first hover or click lands on a listener, not server markup.
export async function openGallery(page: Page, tab?: string): Promise<void> {
  await page.goto(tab ? `/ui-gallery?tab=${tab}` : "/ui-gallery");
  await page.locator('main[data-hydrated="true"]').waitFor();
}
