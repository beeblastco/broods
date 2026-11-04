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

function isStaticScript(url: string): boolean {
  const { pathname } = new URL(url);

  return pathname.includes("/_next/static/") && pathname.endsWith(".js");
}
