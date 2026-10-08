/**
 * Review evidence, not a test: walks the changed screens signed in as the
 * probe user against the dev backend, records the video, and saves a light
 * and a dark screenshot of each. Run with
 * `bun x playwright test --project=app e2e/app/evidence.spec.ts`; the files land under
 * `e2e/evidence-out/`. Pages whose Convex functions the dev backend does
 * not have yet are skipped by name in SKIP.
 */
import { test, type Page } from "@playwright/test";
import { CANVAS_READY, readProjectId } from "../lib/session";

test.use({ video: "on" });

const OUT = "e2e/evidence-out";

// Screens the dev backend cannot serve until the stack deploys its functions.
const SKIP = new Set(process.env.EVIDENCE_SKIP?.split(",") ?? []);

const SCREENS: Array<{ name: string; path: (projectId: string) => string }> = [
  { name: "scheduler", path: (id) => `/${id}/scheduler` },
  { name: "sandbox-instances", path: (id) => `/${id}/sandbox` },
  { name: "sandbox-snapshots", path: (id) => `/${id}/sandbox?tab=snapshots` },
  { name: "monitoring", path: (id) => `/${id}/dashboard?tab=monitoring` },
  { name: "tracing", path: (id) => `/${id}/dashboard?tab=tracing` },
  { name: "keys", path: (id) => `/${id}/settings?tab=keys` },
  { name: "org-members", path: () => `/settings/org?tab=members` },
  { name: "org-roles", path: () => `/settings/org?tab=roles` },
  { name: "org-policies", path: () => `/settings/org?tab=policies` },
  { name: "org-permissions", path: () => `/settings/org?tab=permissions` },
  { name: "org-api-access", path: () => `/settings/org?tab=api-access` },
];

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((next) => {
    window.localStorage.setItem("theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
    document.documentElement.classList.toggle("light", next === "light");
    document.documentElement.style.colorScheme = next;
  }, theme);
  await page.waitForTimeout(300);
}

test("walk the changed screens", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const projectId = readProjectId();
  await page.goto(`/${projectId}`);
  await page.locator(CANVAS_READY).waitFor();

  for (const screen of SCREENS) {
    if (SKIP.has(screen.name)) continue;
    await page.goto(screen.path(projectId));
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await page.screenshot({
        path: `${OUT}/${screen.name}-${theme}.png`,
        fullPage: false,
      });
    }
    await setTheme(page, "dark");
  }

  // The scheduler's header menu and the Filter button, so the video shows
  // the chips landing in the search box.
  if (!SKIP.has("scheduler")) {
    await page.goto(`/${projectId}/scheduler`);
    await page.waitForLoadState("networkidle");
    const agentHead = page.getByRole("button", { name: /^Agent$/ }).first();
    if (await agentHead.isVisible()) {
      await agentHead.click();
      await page.waitForTimeout(800);
      await page.keyboard.press("Escape");
    }
    const filter = page.getByRole("button", { name: /^Filter$/ }).first();
    if (await filter.isVisible()) {
      await filter.click();
      await page.waitForTimeout(800);
      await page.keyboard.press("Escape");
    }
    await page.screenshot({ path: `${OUT}/scheduler-menu-dark.png` });
  }
});
