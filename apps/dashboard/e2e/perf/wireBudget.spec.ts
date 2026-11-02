import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  CANVAS_READY,
  probeAccount,
  readProjectId,
  SIGNED_IN_CONTEXT,
} from "../lib/session";
import { checkPerfBaseline } from "../lib/perfBaseline";
import { waitForReady } from "../lib/timing";

const CONVEX_SYNC = /\/api\/[^/]+\/sync$/;
// The ready marker is the first content, not the last query: settle on a quiet socket.
const QUIET_MS = 1_500;
const SETTLE_TIMEOUT_MS = 20_000;
const PAGES: ProbePage[] = [
  {
    name: "canvas",
    path: () => `/${readProjectId()}`,
    ready: (page) => page.locator(CANVAS_READY),
  },
  {
    name: "monitoring",
    path: () => `/${readProjectId()}/dashboard?tab=monitoring`,
    ready: (page) => page.getByRole("heading", { name: "Monitoring" }),
  },
  {
    name: "settings",
    path: () => `/${readProjectId()}/settings`,
    ready: (page) => page.getByRole("heading", { name: "General" }),
  },
  {
    name: "projects",
    path: () => "/projects",
    ready: (page) => page.getByRole("heading", { name: "Projects" }),
  },
];

// Only results and subscriptions gate: frame envelopes (~200 B each) and how many frames
// carry the results move with timing.
interface WireLoad {
  resultBytes: number;
  subscriptions: number;
  bytesReceived: number;
  framesReceived: number;
}

type QueryWire = Pick<WireLoad, "subscriptions" | "resultBytes">;

interface ProbePage {
  name: string;
  path: () => string;
  ready: (page: Page) => Locator;
}

// `convex` keeps its protocol types out of its package exports, so they are spelled here.
type SentMessage =
  | {
      type: "ModifyQuerySet";
      modifications: Array<
        | { type: "Add"; queryId: number; udfPath: string }
        | { type: "Remove"; queryId: number }
      >;
    }
  | { type: "Connect" | "Authenticate" | "Mutation" | "Action" | "Event" };

type ReceivedMessage =
  | {
      type: "Transition";
      modifications: Array<{
        type: "QueryUpdated" | "QueryFailed" | "QueryRemoved";
        queryId: number;
      }>;
    }
  | {
      type:
        | "TransitionChunk"
        | "MutationResponse"
        | "ActionResponse"
        | "AuthError"
        | "FatalError"
        | "Ping";
    };

test.skip(
  !probeAccount.adminKey,
  "The wire budget is the self-hosted stack's fixture: set E2E_ADMIN_KEY (and E2E_BASE_URL to a build on that stack)",
);

test("a cold load stays within its Convex wire budget", async ({ browser }) => {
  const measured: Record<string, WireLoad> = {};
  const byQuery: Record<string, Record<string, QueryWire>> = {};
  for (const probe of PAGES) {
    const context = await browser.newContext(SIGNED_IN_CONTEXT);
    const page = await context.newPage();
    const load: WireLoad = {
      resultBytes: 0,
      subscriptions: 0,
      bytesReceived: 0,
      framesReceived: 0,
    };
    const queries: Record<string, QueryWire> = {};
    const paths = new Map<number, string>();
    const query = (path: string): QueryWire =>
      (queries[path] ??= { subscriptions: 0, resultBytes: 0 });
    let lastFrameAt = Date.now();
    let devServer = false;
    page.on("websocket", (socket) => {
      const { pathname } = new URL(socket.url());
      if (pathname.includes("/_next/hmr")) devServer = true;
      if (!CONVEX_SYNC.test(pathname)) return;
      socket.on("framesent", ({ payload }) => {
        lastFrameAt = Date.now();
        const message: SentMessage = JSON.parse(payload.toString());
        if (message.type !== "ModifyQuerySet") return;
        for (const change of message.modifications) {
          if (change.type !== "Add") continue;
          load.subscriptions++;
          paths.set(change.queryId, change.udfPath);
          query(change.udfPath).subscriptions++;
        }
      });
      socket.on("framereceived", ({ payload }) => {
        lastFrameAt = Date.now();
        const bytes = Buffer.byteLength(payload);
        load.bytesReceived += bytes;
        load.framesReceived++;
        const message: ReceivedMessage = JSON.parse(payload.toString());
        if (message.type !== "Transition") {
          query(`(${message.type})`).resultBytes += bytes;
          return;
        }
        for (const change of message.modifications) {
          query(paths.get(change.queryId) ?? "(unknown query)").resultBytes +=
            Buffer.byteLength(JSON.stringify(change));
        }
      });
    });

    await page.goto(probe.path(), { waitUntil: "load" });
    // HMR opens as the page boots, so this skips before a cold dev compile times a wait out.
    if (devServer) await context.close();
    test.skip(
      devServer,
      "next dev can subscribe a query twice; run against a build",
    );
    await waitForReady(probe.ready(page));
    await waitForReady(page.locator('[data-hydrated="true"]'));
    await expect
      .poll(() => Date.now() - lastFrameAt, {
        message: `${probe.name}: the Convex socket goes quiet for ${QUIET_MS} ms`,
        intervals: [100],
        timeout: SETTLE_TIMEOUT_MS,
      })
      .toBeGreaterThanOrEqual(QUIET_MS);
    await context.close();

    expect(
      load.subscriptions,
      `${probe.name} subscribes to its queries on the Convex sync socket`,
    ).toBeGreaterThan(0);
    load.resultBytes = Object.values(queries).reduce(
      (sum, wire) => sum + wire.resultBytes,
      0,
    );
    measured[probe.name] = load;
    byQuery[probe.name] = Object.fromEntries(
      Object.entries(queries).sort(
        ([, a], [, b]) => b.resultBytes - a.resultBytes,
      ),
    );
  }

  for (const [name, load] of Object.entries(measured)) {
    console.log(
      `Wire ${name}: ${load.subscriptions} subscriptions, ${(load.resultBytes / 1024).toFixed(1)} kB of results; ${load.framesReceived} frames, ${(load.bytesReceived / 1024).toFixed(1)} kB received`,
    );
  }
  await test.info().attach("wire-by-query", {
    body: JSON.stringify(byQuery, null, 2),
    contentType: "application/json",
  });
  checkPerfBaseline(
    "Convex wire",
    Object.fromEntries(
      Object.entries(measured).flatMap(([name, load]) => [
        [
          `wire.${name}.subscriptions`,
          { value: load.subscriptions, gate: "blocking", maxRegressionPct: 0 },
        ],
        // Room for values that change width when the stack is rebuilt, such as minted tokens.
        [
          `wire.${name}.resultBytes`,
          { value: load.resultBytes, gate: "blocking", maxRegressionPct: 5 },
        ],
        [
          `wire.${name}.bytesReceived`,
          {
            value: load.bytesReceived,
            gate: "informational",
            maxRegressionPct: 30,
          },
        ],
        [
          `wire.${name}.framesReceived`,
          {
            value: load.framesReceived,
            gate: "informational",
            maxRegressionPct: 50,
            slack: 4,
          },
        ],
      ]),
    ),
  );
});
