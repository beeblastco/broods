// THROWAWAY review screenshots for PR 1204. Delete after use; never commit.
import { expect, test, type Page } from "@playwright/test";
import { convex, fileSubscription, STACK_ADMIN } from "../lib/localStack";
import { readProjectId } from "../lib/session";

const OUT = process.env.SHOT_DIR ?? "/tmp/claude-501/pr1204";
const SUB = `sub_review_${Date.now().toString(36)}`;
let managedBefore: string | null | undefined;

test.describe.configure({ mode: "serial", timeout: 120_000 });

test.beforeAll(() => {
  managedBefore =
    convex(["env", "list"]).match(/^BROODS_MANAGED_SERVICE=(.*)$/m)?.[1] ??
    null;
});

test.afterAll(() => {
  try {
    fileSubscription(STACK_ADMIN, SUB, 1, "canceled");
  } finally {
    if (managedBefore !== undefined) {
      convex(
        managedBefore === null
          ? ["env", "remove", "BROODS_MANAGED_SERVICE"]
          : ["env", "set", "BROODS_MANAGED_SERVICE", managedBefore],
      );
    }
  }
});

async function open(page: Page, tab = "billing"): Promise<void> {
  page.removeAllListeners("pageerror");
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  page.removeAllListeners("console");
  page.on(
    "console",
    (m) =>
      m.type() === "error" && console.log("CONSOLE", m.text().slice(0, 400)),
  );
  await page.goto(`/${readProjectId()}/dashboard?tab=${tab}`);
  await page.locator("h2").first().waitFor({ timeout: 30_000 });
}

async function shots(page: Page, name: string): Promise<void> {
  await open(page);
  await expect(
    page.getByRole("heading", { name: /^(Your plan|Plan for .+)$/ }),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${name}-dark.png`, fullPage: true });
  const card = page.locator("section").first().locator("> div").nth(1);
  console.log(
    name,
    "plan card box",
    JSON.stringify(await card.boundingBox({ timeout: 2000 }).catch(() => null)),
  );
  await page.evaluate(() => localStorage.setItem("theme", "light"));
  await open(page);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${name}-light.png`, fullPage: true });
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${name}-390.png`, fullPage: true });
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
    tables: [...document.querySelectorAll('[data-slot="table-container"]')].map(
      (el) => [el.scrollWidth, el.clientWidth],
    ),
  }));
  console.log(name, "390 overflow", JSON.stringify(overflow));
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("self-hosted", async ({ page }) => {
  convex(["env", "remove", "BROODS_MANAGED_SERVICE"]);
  await shots(page, "selfhosted");
});

test("hobby", async ({ page }) => {
  convex(["env", "set", "BROODS_MANAGED_SERVICE", "true"]);
  await shots(page, "hobby");
  // Loading: catch the skeleton as early as possible.
  await page.goto(`/${readProjectId()}/dashboard?tab=billing`, {
    waitUntil: "commit",
  });
  await page
    .locator('[data-slot="skeleton"]')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  await page.screenshot({ path: `${OUT}/hobby-loading.png`, fullPage: true });
  const skel = await page
    .locator('section [data-slot="skeleton"]')
    .first()
    .boundingBox()
    .catch(() => null);
  console.log("skeleton box", JSON.stringify(skel));
  await open(page, "usage");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/usage-dark.png`, fullPage: true });
});

test("pro", async ({ page }) => {
  fileSubscription(STACK_ADMIN, SUB, 1, "active");
  await shots(page, "pro");
});

test("past due", async ({ page }) => {
  fileSubscription(STACK_ADMIN, SUB, 1, "past_due");
  await shots(page, "pastdue");
});
