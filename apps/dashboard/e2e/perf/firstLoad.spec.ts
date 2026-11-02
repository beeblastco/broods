/**
 * First-load budget. A cold load fetches every JS chunk the page needs before
 * its load event, all at once; on a lossy link that burst is the wait (a prod
 * load once took a minute on 40 chunks). This pins how many chunks and how
 * many bytes of JS that burst may cost per page, against the perf baseline
 * (`e2e/lib/perfBaseline.ts`): more fails the run, fewer asks for a record.
 * Bytes are counted decoded: Chrome's encoded size counts the response
 * headers on a CDN's HTTP/2 responses, about 1 kB a chunk.
 * A `next dev` server ships unbundled dev chunks, so there the budget does not apply.
 */
import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import {
  CANVAS_READY,
  hasProbe,
  MISSING_PROBE,
  readProjectId,
  SIGNED_IN_CONTEXT,
} from "../lib/session";
import { checkPerfBaseline } from "../lib/perfBaseline";
import { waitForReady } from "../lib/timing";

// The canvas carries React Flow; the projects page is the shell alone; the
// dashboard opens on Monitoring, its other tabs load when they are opened.
const PAGES: ProbePage[] = [
  {
    name: "canvas",
    path: () => `/${readProjectId()}`,
    ready: (page) => page.locator(CANVAS_READY),
  },
  {
    name: "dashboard",
    path: () => `/${readProjectId()}/dashboard?tab=monitoring`,
    ready: (page) => page.getByRole("heading", { name: "Monitoring" }),
  },
  {
    name: "projects",
    path: () => "/projects",
    ready: (page) => page.getByRole("heading", { name: "Projects" }),
  },
];

interface FirstLoad {
  jsRequests: number;
  jsBytes: number;
}

interface ProbePage {
  name: string;
  path: () => string;
  ready: (page: Page) => Locator;
}

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
      if (socket.url().includes("/_next/hmr")) devServer = true;
    });

    await page.goto(probe.path(), { waitUntil: "load" });
    // The HMR socket opens as the page boots, before any wait below can time
    // out on a cold `next dev` compile.
    if (devServer) await context.close();
    test.skip(devServer, "next dev ships dev chunks; run against a build");
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
    const bodies = await Promise.all(
      responses.flatMap((response) => (response ? [response.body()] : [])),
    );
    await context.close();

    // A chunk that failed or errored must not pass as a lighter page.
    expect(
      firstLoad
        .filter((_, index) => !responses[index]?.ok())
        .map((request) => request.url()),
      `every ${probe.name} chunk loads`,
    ).toEqual([]);
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
      jsBytes: bodies.reduce((sum, body) => sum + body.byteLength, 0),
    };
  }

  for (const [name, load] of Object.entries(measured)) {
    console.log(
      `First load ${name}: ${load.jsRequests} JS requests, ${Math.round(load.jsBytes / 1024)} kB of JS`,
    );
  }
  checkPerfBaseline(
    "first load",
    Object.fromEntries(
      Object.entries(measured).flatMap(([name, load]) => [
        [
          `first-load.${name}.jsRequests`,
          { value: load.jsRequests, gate: "blocking", maxRegressionPct: 0 },
        ],
        // Chunk hashes and minifier output move the size a little per build.
        [
          `first-load.${name}.jsBytes`,
          { value: load.jsBytes, gate: "blocking", maxRegressionPct: 5 },
        ],
      ]),
    ),
  );
});

/** A JS chunk from the build, served by the app or from an asset prefix. */
function isStaticScript(url: string): boolean {
  const { pathname } = new URL(url);

  return pathname.includes("/_next/static/") && pathname.endsWith(".js");
}
