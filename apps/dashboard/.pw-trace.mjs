import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
const out = "/tmp/claude-0/pw";
const browser = await chromium.launch();
const ctx = await browser.newContext({
  storageState: "e2e/.auth/session.json",
  viewport: { width: 1440, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
  colorScheme: process.env.SCHEME ?? "light",
});
const page = await ctx.newPage();
await page.goto("http://localhost:4305/?project=demo&stage=development");
await page.waitForURL(/\/[a-z0-9]{20,}/, { timeout: 60000 });
const projectPath = new URL(page.url()).pathname.split("/")[1];
await page.goto(`http://localhost:4305/${projectPath}/dashboard?tab=tracing`);
await page
  .locator('[data-hydrated="true"]')
  .first()
  .waitFor({ timeout: 60000 });
const task = page.locator('button[id^="task-"]').first();
await task.waitFor({ timeout: 60000 });
await task.click();
const promptButton = page.getByRole("button", {
  name: "Copy prompt for agent",
});
await promptButton.waitFor();
await page.screenshot({
  path: `${out}/tracing-${ctx._options?.colorScheme ?? process.env.SCHEME ?? "light"}.png`,
});
await page.getByRole("button", { name: "Copy trace ID" }).click();
const traceId = await page.evaluate(() => navigator.clipboard.readText());
await promptButton.click();
await page.waitForTimeout(300);
await page.screenshot({
  path: `${out}/tracing-copied-${process.env.SCHEME ?? "light"}.png`,
  clip: { x: 0, y: 0, width: 1440, height: 260 },
});
const prompt = await page.evaluate(() => navigator.clipboard.readText());
writeFileSync(`${out}/prompt.txt`, prompt);
console.log("TRACE", traceId);
console.log(prompt);
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({
  path: `${out}/tracing-phone-${process.env.SCHEME ?? "light"}.png`,
});
await browser.close();
