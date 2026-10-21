/**
 * First-load budget. A cold load fetches every JS chunk the page needs before
 * its load event, all at once; on a lossy link that burst is the wait (a prod
 * load once took a minute on 40 chunks). This pins how many chunks and how
 * many bytes on the wire that burst may cost per page, against
 * `first-load-budget.json`: more fails the run, fewer asks for a record.
 * `E2E_RECORD_FIRST_LOAD=1` rewrites the budget from this run. A `next dev`
 * server ships unbundled dev chunks, so there the budget does not apply.
 */
import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANVAS_READY,
  hasProbe,
  MISSING_PROBE,
  readProjectId,
  SIGNED_IN_CONTEXT,
} from "../lib/session";
import { waitForReady } from "../lib/timing";

const BUDGET_FILE = join(__dirname, "first-load-budget.json");
// Chunk hashes and minifier output move the gzip size a little per build.
const BYTES_HEADROOM = 1.05;
const RECORD = process.env.E2E_RECORD_FIRST_LOAD === "1";

interface FirstLoad {
  jsRequests: number;
  jsBytes: number;
}

// The canvas carries React Flow; the projects page is the shell alone.
const PAGES: Array<{
  name: string;
  path: () => string;
  ready: (page: Page) => Locator;
}> = [
  {
    name: "canvas",
    path: () => `/${readProjectId()}`,
    ready: (page) => page.locator(CANVAS_READY),
  },
  {
    name: "projects",
    path: () => "/projects",
    ready: (page) => page.getByRole("heading", { name: "Projects" }),
  },
];

test.skip(!hasProbe(), MISSING_PROBE);

test("a cold load stays within its JS budget, every chunk cacheable", async ({
  browser,
}) => {
  const measured: Record<string, FirstLoad> = {};
  for (const probe of PAGES) {
    const context = await browser.newContext(SIGNED_IN_CONTEXT);
    const page = await context.newPage();
    const scripts: Array<{ at: number; request: Request }> = [];
    let devServer = false;
    page.on("request", (request: Request) => {
      if (isStaticScript(request.url())) {
        scripts.push({ at: Date.now(), request: request });
      }
    });
    page.on("websocket", (socket) => {
      if (socket.url().includes("/_next/webpack-hmr")) devServer = true;
    });

    await page.goto(probe.path(), { waitUntil: "load" });
    await waitForReady(probe.ready(page));
    await waitForReady(page.locator('[data-hydrated="true"]'));
    // Only the chunks asked for before the load event: what loads after it
    // (analytics, prefetches) no longer holds the page up.
    const loadedAt = await page.evaluate((): number => {
      const navigation = performance
        .getEntriesByType("navigation")
        .find(
          (entry): entry is PerformanceNavigationTiming =>
            entry instanceof PerformanceNavigationTiming,
        );

      return performance.timeOrigin + (navigation?.loadEventStart ?? 0);
    });
    const firstLoad = scripts
      .filter((script) => script.at < loadedAt)
      .map((script) => script.request);
    const responses = await Promise.all(
      firstLoad.map((request) => request.response()),
    );
    const sizes = await Promise.all(
      firstLoad.map((request) => request.sizes()),
    );
    await context.close();
    test.skip(devServer, "next dev ships dev chunks; run against a build");

    expect(
      responses
        .filter(
          (response) =>
            response &&
            !response.headers()["cache-control"]?.includes("immutable"),
        )
        .map((response) => response?.url()),
      `every ${probe.name} chunk is immutable, so an edge cache can hold it`,
    ).toEqual([]);
    measured[probe.name] = {
      jsRequests: firstLoad.length,
      jsBytes: sizes.reduce((sum, size) => sum + size.responseBodySize, 0),
    };
  }

  for (const [name, load] of Object.entries(measured)) {
    console.log(
      `First load ${name}: ${load.jsRequests} JS requests, ${Math.round(load.jsBytes / 1024)} kB on the wire`,
    );
  }
  if (RECORD) {
    const budget = Object.fromEntries(
      Object.entries(measured).map(([name, load]) => [
        name,
        {
          jsRequests: load.jsRequests,
          jsBytes: Math.ceil(load.jsBytes * BYTES_HEADROOM),
        },
      ]),
    );
    writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`);

    return;
  }

  const budget: Record<string, FirstLoad> = JSON.parse(
    readFileSync(BUDGET_FILE, "utf8"),
  );
  for (const [name, load] of Object.entries(measured)) {
    expect(
      load.jsRequests,
      `${name}: JS requests before the load event`,
    ).toBeLessThanOrEqual(budget[name].jsRequests);
    expect(
      load.jsBytes,
      `${name}: JS bytes before the load event`,
    ).toBeLessThanOrEqual(budget[name].jsBytes);
    if (load.jsRequests < budget[name].jsRequests) {
      console.log(
        `${name}: fewer JS requests than the budget (${budget[name].jsRequests}); record with E2E_RECORD_FIRST_LOAD=1 to lock the gain in`,
      );
    }
  }
});

/** A JS chunk from the build, served by the app or from an asset prefix. */
function isStaticScript(url: string): boolean {
  const { pathname } = new URL(url);

  return pathname.includes("/_next/static/") && pathname.endsWith(".js");
}
