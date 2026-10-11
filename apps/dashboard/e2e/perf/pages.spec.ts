/**
 * Render-budget probe. Loads every page cold in its own fresh browser context
 * (so no page is served from another's cache) and reaches every sidebar
 * destination by client-side navigation. Each is timed until its own content
 * is on screen; anything over the render budget fails the run. The
 * dashboard sub-tabs (Monitoring, Tracing, Usage, Billing) are covered by the
 * cold loads; sidebar navigation covers the top-level routes. A second test
 * loads Monitoring with history and drives a live log burst through it. The
 * session and project come from `auth.setup.ts`.
 */
import {
  expect,
  test,
  type Locator,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";
import type { ObservabilityLogEntry } from "../../../../packages/broods/src/observability-contracts";
import { PAGE_RENDER_BUDGET_MS, PERF_BUDGETS } from "../../app/lib/perfReport";
import {
  BASE_URL,
  CANVAS_READY,
  hasProbe,
  MISSING_PROBE,
  readProjectId,
  SIGNED_IN_CONTEXT,
} from "../lib/session";
import { timeClientNavigation, waitForReady } from "../lib/timing";

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
// The live burst: the hook's whole retention, the most one burst can show.
const BURST_EVENTS = 2_000;
const BACKFILL_ROWS = 200;

/**
 * A deployment is probed from a GitHub runner on another continent, so the
 * network is in the number: measured from Azure westus2 to Hetzner, every
 * page loads cold in 2.3 s and the canvas in 2.9 s, at a 160 ms round trip.
 * The same margin over that as PAGE_RENDER_BUDGET_MS holds over the local
 * figures. A server on this machine, on any port (the local stack's own), keeps
 * the page's own budget.
 */
const DEPLOYED_RENDER_BUDGET_MS = 3500;
const RENDER_BUDGET_MS = ["localhost", "127.0.0.1"].includes(
  new URL(BASE_URL).hostname,
)
  ? PAGE_RENDER_BUDGET_MS
  : DEPLOYED_RENDER_BUDGET_MS;

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
    ready: (page) => page.getByRole("heading", { name: "Instances" }),
  },
  {
    name: "Settings",
    path: "/settings",
    ready: (page) => page.getByRole("heading", { name: "General" }),
  },
];

// Sidebar destinations reached by client-side navigation, each paired with the
// marker that means it has rendered. "Dashboard" lands on the Monitoring tab,
// so its marker is that tab's heading, not a probe named "Dashboard".
const SIDEBAR_NAV: Array<{ label: string; ready: (page: Page) => Locator }> = [
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
    ready: (page) => page.getByRole("heading", { name: "Instances" }),
  },
  {
    label: "Settings",
    ready: (page) => page.getByRole("heading", { name: "General" }),
  },
  {
    label: "Architecture",
    ready: (page) => page.locator(CANVAS_READY),
  },
];

test.skip(!hasProbe(), MISSING_PROBE);

test("every page renders cold within budget, and every sidebar destination by navigation", async ({
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
      await waitForReady(probe.ready(page));
      // performance.now() counts from this document's navigation start, so
      // it is the cold-load time to the ready marker with no harness overhead.
      fastest = Math.min(fastest, await page.evaluate(() => performance.now()));
      await context.close();
    }
    samples.push({ page: probe.name, kind: "cold", ms: fastest });
  }

  // Client-side navigation across the sidebar, one warm context, the path a
  // user actually walks between top-level routes.
  const navContext = await browser.newContext(SIGNED_IN_CONTEXT);
  const navPage = await navContext.newPage();
  await navPage.goto(`/${projectId}`, { waitUntil: "commit" });
  await waitForReady(PROJECT_PAGES[0].ready(navPage));
  for (const dest of SIDEBAR_NAV) {
    const ms = await timeClientNavigation(
      navPage,
      () =>
        navPage.getByRole("link", { name: dest.label, exact: true }).click(),
      dest.ready(navPage),
    );
    samples.push({ page: dest.label, kind: "navigate", ms: ms });
  }
  await navContext.close();

  const report = samples
    .map(
      (sample) =>
        `${sample.kind.padEnd(8)} ${sample.page.padEnd(13)} ${Math.round(sample.ms).toString().padStart(5)} ms${
          sample.ms > RENDER_BUDGET_MS ? "  OVER BUDGET" : ""
        }`,
    )
    .join("\n");
  console.log(`Render budget ${RENDER_BUDGET_MS} ms\n${report}`);
  await test.info().attach("render-times", {
    body: JSON.stringify(samples, null, 2),
    contentType: "application/json",
  });

  const over = samples.filter((sample) => sample.ms > RENDER_BUDGET_MS);
  expect(
    over.map(
      (sample) => `${sample.kind} ${sample.page}: ${Math.round(sample.ms)} ms`,
    ),
    `pages over the ${RENDER_BUDGET_MS} ms render budget`,
  ).toEqual([]);
});

// A busy stage on Monitoring: history on screen and a line open, then a burst
// of live lines with the mix a real stream carries (mostly short lines, an
// occasional large payload, stragglers older than what is shown, and lines
// that arrive twice). The socket is answered here, so the numbers are the
// page's own: how long until the newest line is on screen, and how long the
// main thread was blocked on the way.
test("a live log burst on Monitoring reaches the screen without blocking the page", async ({
  browser,
}) => {
  const projectId = readProjectId();
  const context = await browser.newContext(SIGNED_IN_CONTEXT);
  const page = await context.newPage();
  const now = Date.now();
  const socket = new Promise<WebSocketRoute>((resolve) => {
    void page.routeWebSocket(/\/observability\/ws$/, (route) => {
      route.onMessage((raw) => {
        if (JSON.parse(String(raw)).type !== "subscribe") return;
        route.send(JSON.stringify({ type: "ready" }));
        route.send(
          JSON.stringify({
            type: "backfill",
            stream: "logs",
            entries: Array.from({ length: BACKFILL_ROWS }, (_, index) =>
              logLine(`backfill ${index}`, now - 60_000 + index * 100, 300),
            ),
          }),
        );
        resolve(route);
      });
    });
  });
  await page.goto(`/${projectId}/dashboard?tab=monitoring`, {
    waitUntil: "commit",
  });
  const route = await socket;
  const opened = page.getByRole("cell", {
    name: `backfill ${BACKFILL_ROWS - 1}`,
    exact: true,
  });
  await waitForReady(opened);
  await opened.click();
  const detail = page.getByText("Event type", { exact: true });
  await waitForReady(detail);

  const burst = Array.from({ length: BURST_EVENTS }, (_, index) => {
    // Every 25th line is a straggler, older than everything since the
    // backfill; every 50th repeats the line before it.
    const at = index % 25 === 12 ? now - 30_000 + index : now + index;
    const name = index % 50 === 49 ? `burst ${index - 1}` : `burst ${index}`;
    const repeatAt = index % 50 === 49 ? now + index - 1 : at;

    return JSON.stringify({
      type: "log",
      entry: logLine(name, repeatAt, index % 100 === 0 ? 8_000 : 300),
    });
  });
  const longTasks = await page.evaluateHandle(() => {
    const durations: number[] = [];
    new PerformanceObserver((list) => {
      durations.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ type: "longtask" });

    return durations;
  });
  const start = performance.now();
  for (const message of burst) route.send(message);
  await waitForReady(
    page.getByRole("cell", { name: `burst ${BURST_EVENTS - 1}`, exact: true }),
  );
  const visibleMs = performance.now() - start;
  // A task still running when the row lands is reported when it ends.
  await page.waitForTimeout(250);
  const tasks = await longTasks.jsonValue();
  const longestMs = Math.max(0, ...tasks);
  await expect(detail).toBeVisible();
  await context.close();

  const result = {
    events: BURST_EVENTS,
    visibleMs: Math.round(visibleMs),
    longTasks: tasks.length,
    longestTaskMs: Math.round(longestMs),
    totalLongTaskMs: Math.round(tasks.reduce((sum, ms) => sum + ms, 0)),
  };
  console.log(`Live burst ${JSON.stringify(result)}`);
  await test.info().attach("burst", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  expect(
    visibleMs,
    `newest of ${BURST_EVENTS} live lines on screen`,
  ).toBeLessThanOrEqual(RENDER_BUDGET_MS);
  expect(longestMs, "longest main-thread task").toBeLessThanOrEqual(
    PERF_BUDGETS["long-task"],
  );
});

/** One log line whose row reads `name`, padded to about `bytes` of message. */
function logLine(
  name: string,
  ts: number,
  bytes: number,
): ObservabilityLogEntry {
  return {
    ts: ts,
    level: "INFO",
    eventType: "",
    message: JSON.stringify({ message: name, payload: "x".repeat(bytes) }),
    service: "core",
  };
}
