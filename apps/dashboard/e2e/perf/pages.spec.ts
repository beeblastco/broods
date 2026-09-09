/**
 * Render-budget probe. Loads every page cold in its own fresh browser context
 * (so no page is served from another's cache) and reaches every header
 * destination by client-side navigation. Each is timed until its own content
 * is on screen; anything over PAGE_RENDER_BUDGET_MS fails the run. The
 * dashboard sub-tabs (Monitoring, Tracing, Usage, Billing) are covered by the
 * cold loads; header navigation covers the top-level routes. The session and
 * project come from `auth.setup.ts`.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PAGE_RENDER_BUDGET_MS } from "../../app/lib/perfReport";
import {
  CANVAS_READY,
  hasProbe,
  MISSING_PROBE,
  readProjectId,
  SIGNED_IN_CONTEXT,
} from "../lib/session";

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

const COLD_VISITS = 2;

// Pages under one project, keyed by the nav label that reaches them.
const PROJECT_PAGES: ProbePage[] = [
  {
    name: "Architecture",
    path: "",
    ready: (page) => page.locator(CANVAS_READY),
  },
  {
    name: "Dashboard",
    path: "/dashboard?tab=monitoring",
    ready: (page) => page.getByRole("heading", { name: "Monitoring" }),
  },
  {
    name: "Tracing",
    path: "/dashboard?tab=tracing",
    ready: (page) => page.getByRole("heading", { name: "Tracing" }),
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

// Header destinations reached by client-side navigation, each paired with the
// marker that means it has rendered. "Dashboard" lands on the Monitoring tab,
// so its marker is that tab's heading, not a probe named "Dashboard".
const HEADER_NAV: Array<{ label: string; ready: (page: Page) => Locator }> = [
  {
    label: "Dashboard",
    ready: (page) => page.getByRole("heading", { name: "Monitoring" }),
  },
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
    ready: (page) => page.locator(CANVAS_READY),
  },
];

test.skip(!hasProbe(), MISSING_PROBE);

test("every page renders cold within budget, and every header destination by navigation", async ({
  browser,
}) => {
  const projectId = readProjectId();
  const samples: Sample[] = [];

  // Cold load: a throwaway context per visit, so nothing is served from
  // another page's cache and each timing is a true first visit. The faster
  // of two visits counts: a shared runner swings by hundreds of ms between
  // runs, and the budget is for the page, not the runner.
  for (const probe of PROJECT_PAGES) {
    let fastest = Number.POSITIVE_INFINITY;
    for (let visit = 0; visit < COLD_VISITS; visit++) {
      const context = await browser.newContext(SIGNED_IN_CONTEXT);
      const page = await context.newPage();
      await page.goto(`/${projectId}${probe.path}`, { waitUntil: "commit" });
      await probe.ready(page).first().waitFor({ timeout: 30_000 });
      // performance.now() counts from this document's navigation start, so
      // it is the cold-load time to the ready marker with no harness overhead.
      fastest = Math.min(fastest, await page.evaluate(() => performance.now()));
      await context.close();
    }
    samples.push({ page: probe.name, kind: "cold", ms: fastest });
  }

  // Client-side navigation across the header, one warm context, the path a
  // user actually walks between top-level routes.
  const navContext = await browser.newContext(SIGNED_IN_CONTEXT);
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
