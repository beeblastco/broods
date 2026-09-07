/**
 * Render-budget probe against a deployed dashboard. Signs in through the
 * hosted AuthKit form, then loads every page cold and reaches every page by
 * client-side navigation, timing each until the page's own content is on
 * screen. Any page over PAGE_RENDER_BUDGET_MS fails the run.
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

test("every page renders within the budget, cold and by navigation", async ({
  page,
}) => {
  await signIn(page);
  const projectId = process.env.PERF_PROJECT_ID ?? (await firstProjectId(page));
  const samples: Sample[] = [];

  for (const probe of PROJECT_PAGES) {
    const url = `/${projectId}${probe.path}`;
    await page.goto(url, { waitUntil: "commit" });
    await probe.ready(page).first().waitFor({ timeout: 30_000 });
    // performance.now() counts from this document's navigation start, so it
    // is the cold-load time to the ready marker without any harness overhead.
    const ms = await page.evaluate(() => performance.now());
    samples.push({ page: probe.name, kind: "cold", ms: ms });
  }

  // Client-side navigation: Architecture → Dashboard → Scheduler → Sandbox →
  // Settings → Architecture through the header links, the path a user takes.
  const navLinks = [
    "Dashboard",
    "Scheduler",
    "Sandbox",
    "Settings",
    "Architecture",
  ];
  await page.goto(`/${projectId}`, { waitUntil: "commit" });
  await PROJECT_PAGES[0].ready(page).first().waitFor({ timeout: 30_000 });
  for (const label of navLinks) {
    const target = PROJECT_PAGES.find((probe) => probe.name === label)!;
    const start = await page.evaluate(() => performance.now());
    await page.getByRole("link", { name: label, exact: true }).click();
    await target.ready(page).first().waitFor({ timeout: 30_000 });
    const end = await page.evaluate(() => performance.now());
    samples.push({ page: label, kind: "navigate", ms: end - start });
  }

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
