/**
 * Render-budget probe against a deployed dashboard. Signs in once through the
 * hosted AuthKit form and reuses that session. Loads every page cold in its
 * own fresh browser context (so no page is served from another's cache), and
 * reaches every header destination by client-side navigation. Each is timed
 * until its own content is on screen; anything over PAGE_RENDER_BUDGET_MS
 * fails the run. The dashboard sub-tabs (Monitoring, Tracing, Usage, Billing)
 * are covered by the cold loads; header navigation covers the top-level routes.
 *
 * Env: PERF_BASE_URL (the deployment), PERF_EMAIL + PERF_PASSWORD (a member
 * of an org with at least one project), optional PERF_PROJECT_ID.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PAGE_RENDER_BUDGET_MS } from "../../app/lib/perfReport";

interface ProbePage {
  name: string;
  path: string;
  // The element that means this page's own content is on screen.
  ready: (page: Page) => Locator;
}

interface Sample {
  page: string;
  kind: "cold" | "navigate";
  ms: number;
}

const BASE_URL = process.env.PERF_BASE_URL;
const EMAIL = process.env.PERF_EMAIL;
const PASSWORD = process.env.PERF_PASSWORD;
const AUTH_TIMEOUT_MS = 60_000;

// Pages under one project, keyed by the nav label that reaches them.
const PROJECT_PAGES: ProbePage[] = [
  {
    name: "Architecture",
    path: "",
    ready: (page) => page.locator(".react-flow__viewport"),
  },
  {
    name: "Dashboard",
    path: "/dashboard?tab=monitoring",
    ready: (page) => page.getByRole("table"),
  },
  {
    name: "Tracing",
    path: "/dashboard?tab=tracing",
    ready: (page) => page.getByRole("table"),
  },
  {
    name: "Usage",
    path: "/dashboard?tab=usage",
    ready: (page) => page.getByRole("heading", { name: "Usage" }),
  },
  {
    name: "Billing",
    path: "/dashboard?tab=billing",
    ready: (page) => page.getByRole("heading", { name: "Billing & Plan" }),
  },
  {
    name: "Scheduler",
    path: "/scheduler",
    ready: (page) => page.getByRole("heading", { name: "Scheduler" }),
  },
  {
    name: "Sandbox",
    path: "/sandbox",
    ready: (page) => page.getByRole("heading", { name: "Sandboxes" }),
  },
  {
    name: "Settings",
    path: "/settings",
    ready: (page) => page.getByRole("heading", { name: "Settings" }).first(),
  },
];

test.skip(
  !BASE_URL || !EMAIL || !PASSWORD,
  "PERF_BASE_URL, PERF_EMAIL and PERF_PASSWORD pick the deployment to probe",
);

// Header destinations reached by client-side navigation, each paired with the
// marker that means it has rendered. "Dashboard" lands on the Monitoring tab,
// so its marker is the log table, not a probe named "Dashboard".
const HEADER_NAV: Array<{ label: string; ready: (page: Page) => Locator }> = [
  { label: "Dashboard", ready: (page) => page.getByRole("table") },
  {
    label: "Scheduler",
    ready: (page) => page.getByRole("heading", { name: "Scheduler" }),
  },
  {
    label: "Sandbox",
    ready: (page) => page.getByRole("heading", { name: "Sandboxes" }),
  },
  {
    label: "Settings",
    ready: (page) => page.getByRole("heading", { name: "Settings" }).first(),
  },
  {
    label: "Architecture",
    ready: (page) => page.locator(".react-flow__viewport"),
  },
];

test("every page renders cold within budget, and every header destination by navigation", async ({
  browser,
}) => {
  // Sign in once and reuse the session; capturing storageState lets each cold
  // probe start from a fresh, empty-cache context that is still authenticated.
  const authContext = await browser.newContext({ baseURL: BASE_URL! });
  const authPage = await authContext.newPage();
  await signIn(authPage);
  const projectId =
    process.env.PERF_PROJECT_ID ?? (await firstProjectId(authPage));
  const storageState = await authContext.storageState();
  await authContext.close();

  const samples: Sample[] = [];

  // Cold load: one throwaway context per page, so nothing is served from
  // another page's cache and each timing is a true first visit.
  for (const probe of PROJECT_PAGES) {
    const context = await browser.newContext({
      baseURL: BASE_URL!,
      storageState: storageState,
    });
    const page = await context.newPage();
    await page.goto(`/${projectId}${probe.path}`, { waitUntil: "commit" });
    await probe.ready(page).first().waitFor({ timeout: 30_000 });
    // performance.now() counts from this document's navigation start, so it
    // is the cold-load time to the ready marker without any harness overhead.
    const ms = await page.evaluate(() => performance.now());
    samples.push({ page: probe.name, kind: "cold", ms: ms });
    await context.close();
  }

  // Client-side navigation across the header, one warm context, the path a
  // user actually walks between top-level routes.
  const navContext = await browser.newContext({
    baseURL: BASE_URL!,
    storageState: storageState,
  });
  const navPage = await navContext.newPage();
  await navPage.goto(`/${projectId}`, { waitUntil: "commit" });
  await PROJECT_PAGES[0].ready(navPage).first().waitFor({ timeout: 30_000 });
  for (const dest of HEADER_NAV) {
    const start = await navPage.evaluate(() => performance.now());
    await navPage.getByRole("link", { name: dest.label, exact: true }).click();
    await dest.ready(navPage).first().waitFor({ timeout: 30_000 });
    const end = await navPage.evaluate(() => performance.now());
    samples.push({ page: dest.label, kind: "navigate", ms: end - start });
  }
  await navContext.close();

  const report = samples
    .map(
      (sample) =>
        `${sample.kind.padEnd(8)} ${sample.page.padEnd(13)} ${Math.round(sample.ms).toString().padStart(5)} ms${
          sample.ms > PAGE_RENDER_BUDGET_MS ? "  OVER BUDGET" : ""
        }`,
    )
    .join("\n");
  console.log(`Render budget ${PAGE_RENDER_BUDGET_MS} ms\n${report}`);
  await test.info().attach("render-times", {
    body: JSON.stringify(samples, null, 2),
    contentType: "application/json",
  });

  const over = samples.filter((sample) => sample.ms > PAGE_RENDER_BUDGET_MS);
  expect(
    over.map(
      (sample) => `${sample.kind} ${sample.page}: ${Math.round(sample.ms)} ms`,
    ),
    `pages over the ${PAGE_RENDER_BUDGET_MS} ms render budget`,
  ).toEqual([]);
});

/** Drive the hosted AuthKit sign-in form until the app is back on its own origin. */
async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForURL((url) => url.origin !== new URL(BASE_URL!).origin, {
    timeout: AUTH_TIMEOUT_MS,
  });
  await page.getByLabel(/email/i).fill(EMAIL!);
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/password/i).fill(PASSWORD!);
  await page.getByRole("button", { name: /continue|sign in/i }).click();
  await page.waitForURL((url) => url.origin === new URL(BASE_URL!).origin, {
    timeout: AUTH_TIMEOUT_MS,
  });
}

/** The first project card on the projects page; its href is `/<projectId>`. */
async function firstProjectId(page: Page): Promise<string> {
  await page.goto("/projects");
  await page.getByRole("heading", { name: "Projects" }).waitFor();
  const href = await page
    .locator('a[href^="/"]')
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute("href") ?? "")
        .find((value) => /^\/[a-z0-9]+$/.test(value) && value !== "/projects"),
    );
  if (!href) throw new Error("No project found for the probe account");

  return href.slice(1);
}
