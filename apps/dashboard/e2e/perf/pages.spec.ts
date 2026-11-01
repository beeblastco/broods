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
import {
  LONG_TASK_SETTLE_MS,
  timeClientNavigation,
  waitForReady,
  watchLongTasks,
} from "../lib/timing";

interface ProbePage {
  name: string;
  path: string;
  ready: (page: Page) => Locator;
}

interface Sample {
  page: string;
  kind: "cold" | "navigate";
  ms: number;
}

const COLD_VISITS = 2;
// The log hook's whole retention, the most one burst can show.
const BURST_EVENTS = 2_000;
const BACKFILL_ROWS = 200;

// A deployment is probed from a runner 160 ms away: pages took 2.3 s cold, the canvas 2.9 s.
// This keeps PAGE_RENDER_BUDGET_MS's margin over those figures.
const DEPLOYED_RENDER_BUDGET_MS = 3500;
const RENDER_BUDGET_MS = ["localhost", "127.0.0.1"].includes(
  new URL(BASE_URL).hostname,
)
  ? PAGE_RENDER_BUDGET_MS
  : DEPLOYED_RENDER_BUDGET_MS;

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

test("every page renders cold within budget, and every sidebar destination by navigation @post-rollout", async ({
  browser,
}) => {
  const projectId = readProjectId();
  const samples: Sample[] = [];

  // The faster of two cold visits counts: a shared runner swings by hundreds of ms.
  for (const probe of PROJECT_PAGES) {
    let fastest = Number.POSITIVE_INFINITY;
    for (let visit = 0; visit < COLD_VISITS; visit++) {
      const context = await browser.newContext(SIGNED_IN_CONTEXT);
      const page = await context.newPage();
      await page.goto(`/${projectId}${probe.path}`, { waitUntil: "commit" });
      await waitForReady(probe.ready(page));
      fastest = Math.min(fastest, await page.evaluate(() => performance.now()));
      await context.close();
    }
    samples.push({ page: probe.name, kind: "cold", ms: fastest });
  }

  const navContext = await browser.newContext(SIGNED_IN_CONTEXT);
  const navPage = await navContext.newPage();
  await navPage.goto(`/${projectId}`, { waitUntil: "commit" });
  await waitForReady(PROJECT_PAGES[0].ready(navPage));
  // The start page is ready before hydration; a click that early loads a new document.
  await waitForReady(navPage.locator('[data-hydrated="true"]'));
  for (const dest of SIDEBAR_NAV) {
    const link = navPage.getByRole("link", { name: dest.label, exact: true });
    const ms = await timeClientNavigation(
      navPage,
      () => link.click(),
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

test("a live log burst on Monitoring reaches the screen without blocking the page", async ({
  browser,
}) => {
  const projectId = readProjectId();
  const context = await browser.newContext(SIGNED_IN_CONTEXT);
  const page = await context.newPage();
  const now = Date.now();
  // Routed before goto: a route added while the page loads never reaches that document.
  const subscribed: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/observability\/ws$/, (socket) => {
    socket.onMessage(() => {
      socket.send(JSON.stringify({ type: "ready" }));
      socket.send(
        JSON.stringify({
          type: "backfill",
          stream: "logs",
          entries: Array.from({ length: BACKFILL_ROWS }, (_, index) =>
            logLine(`backfill ${index}`, now - 60_000 + index * 100, 300),
          ),
        }),
      );
      subscribed.push(socket);
    });
  });
  await page.goto(`/${projectId}/dashboard?tab=monitoring`, {
    waitUntil: "commit",
  });
  await expect
    .poll(() => subscribed.length, {
      message: "Monitoring subscribes to its log stream",
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const route = subscribed[0];
  const opened = page.getByRole("cell", {
    name: `backfill ${BACKFILL_ROWS - 1}`,
    exact: true,
  });
  await waitForReady(opened);
  await opened.click();
  const detail = page.getByRole("button", { name: "Close details" });
  await waitForReady(detail);

  const burst = Array.from({ length: BURST_EVENTS }, (_, index) => {
    // Every 50th line repeats the one before it; every 25th is older than all before it.
    const line = index % 50 === 25 ? index - 1 : index;
    const at = line % 25 === 12 ? now - 30_000 + line : now + line;

    return JSON.stringify({
      type: "log",
      entry: logLine(`burst ${line}`, at, line % 100 === 0 ? 8_000 : 300),
    });
  });
  const longTasks = await watchLongTasks(page);
  const start = performance.now();
  for (const message of burst) route.send(message);
  await waitForReady(
    page.getByRole("cell", { name: `burst ${BURST_EVENTS - 1}`, exact: true }),
  );
  const visibleMs = performance.now() - start;
  await page.waitForTimeout(LONG_TASK_SETTLE_MS);
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
  // Every frame rides the browser protocol, in this number as a network is: deployed budget.
  expect(
    visibleMs,
    `newest of ${BURST_EVENTS} live lines on screen`,
  ).toBeLessThanOrEqual(DEPLOYED_RENDER_BUDGET_MS);
  expect(longestMs, "longest main-thread task").toBeLessThanOrEqual(
    PERF_BUDGETS["long-task"],
  );
});

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
