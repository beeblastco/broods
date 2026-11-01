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
const BYTES_HEADROOM = 1.05;
const RECORD = process.env.E2E_RECORD_FIRST_LOAD === "1";
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
    // HMR opens as the page boots, so this skips before a cold dev compile times a wait out.
    if (devServer) await context.close();
    test.skip(devServer, "next dev ships dev chunks; run against a build");
    await waitForReady(probe.ready(page));
    await waitForReady(page.locator('[data-hydrated="true"]'));
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
      // Decoded: Chrome's encoded size counts a CDN's HTTP/2 headers, about 1 kB a chunk.
      jsBytes: bodies.reduce((sum, body) => sum + body.byteLength, 0),
    };
  }

  for (const [name, load] of Object.entries(measured)) {
    console.log(
      `First load ${name}: ${load.jsRequests} JS requests, ${Math.round(load.jsBytes / 1024)} kB of JS`,
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

  const budget: Partial<Record<string, FirstLoad>> = JSON.parse(
    readFileSync(BUDGET_FILE, "utf8"),
  );
  for (const [name, load] of Object.entries(measured)) {
    const allowed = budget[name];
    if (!allowed) {
      throw new Error(
        `${name}: no first-load budget; record one with E2E_RECORD_FIRST_LOAD=1`,
      );
    }
    expect(
      load.jsRequests,
      `${name}: JS requests before the load event`,
    ).toBeLessThanOrEqual(allowed.jsRequests);
    expect(
      load.jsBytes,
      `${name}: JS bytes before the load event`,
    ).toBeLessThanOrEqual(allowed.jsBytes);
    if (load.jsRequests < allowed.jsRequests) {
      console.log(
        `${name}: fewer JS requests than the budget (${allowed.jsRequests}); record with E2E_RECORD_FIRST_LOAD=1 to lock the gain in`,
      );
    }
  }
});

function isStaticScript(url: string): boolean {
  const { pathname } = new URL(url);

  return pathname.includes("/_next/static/") && pathname.endsWith(".js");
}
