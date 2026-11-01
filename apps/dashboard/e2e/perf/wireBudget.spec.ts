/**
 * Convex wire budget. A page reads its data as query subscriptions on one
 * Convex sync socket, and a cold load pulls every result down it whole: a
 * query that returns more than the page shows, a page that subscribes to one
 * it never renders, or a second Authenticate that re-runs every subscription
 * costs bytes on every visit and shows nothing for it. This pins, per page,
 * the result bytes that socket delivers on a cold load and the queries the
 * page subscribes to, against `wire-budget.json`: more fails the run, fewer
 * asks for a record. Every frame also carries a version envelope of about
 * 200 B, and how many frames the server packs the results into, and how many
 * bare ones it sends as the deployment's clock moves, is timing: the total
 * bytes and the frames are recorded beside the budget but do not gate (on one
 * fixture the canvas total moved 9% between runs, its results not a byte).
 * Bytes are the decoded payloads, the JSON the client parses, so the
 * socket's compression does not move them.
 * `E2E_RECORD_WIRE_BUDGET=1` rewrites the budget from this run. The numbers
 * are the fixture's: only a self-hosted stack (`E2E_ADMIN_KEY`) holds a fixed
 * one, so the budget applies only there. A `next dev` server mounts every
 * component twice (Strict Mode), so a query can subscribe, drop and
 * subscribe again: the budget does not apply there either.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANVAS_READY,
  probeAccount,
  readProjectId,
  SIGNED_IN_CONTEXT,
} from "../lib/session";
import { waitForReady } from "../lib/timing";

const BUDGET_FILE = join(__dirname, "wire-budget.json");
// The 5% first-load allows. On one fixture the results held to the byte over
// eight runs; the room is for values that change width when the stack is
// rebuilt, such as minted tokens and counts.
const BYTES_HEADROOM = 1.05;
const RECORD = process.env.E2E_RECORD_WIRE_BUDGET === "1";
// The client's sync socket: `/api/<version>/sync` on the Convex origin.
const CONVEX_SYNC = /\/api\/[^/]+\/sync$/;
// The ready marker is the first content, not the last query: the page has
// settled once the socket has been quiet this long.
const QUIET_MS = 1_500;
const SETTLE_TIMEOUT_MS = 20_000;
// The canvas reads every agent's config; Monitoring and Settings the
// project's shell plus their own; the projects page is the org shell alone.
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

interface WireLoad {
  /** The query results and responses, without each frame's envelope. */
  resultBytes: number;
  subscriptions: number;
  /** Every frame the socket delivered, envelopes included. */
  bytesReceived: number;
  framesReceived: number;
}

/** One query path's share of a page's load. */
type QueryWire = Pick<WireLoad, "subscriptions" | "resultBytes">;

interface ProbePage {
  name: string;
  path: () => string;
  ready: (page: Page) => Locator;
}

/**
 * The client messages this spec reads. `convex` keeps its protocol types
 * out of its package exports, so the shape is spelled here.
 */
type SentMessage =
  | {
      type: "ModifyQuerySet";
      modifications: Array<
        | { type: "Add"; queryId: number; udfPath: string }
        | { type: "Remove"; queryId: number }
      >;
    }
  | { type: "Connect" | "Authenticate" | "Mutation" | "Action" | "Event" };

/** The server messages this spec reads, to name the queries the bytes went to. */
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
  // Per page and query path, so a failure names the query that grew.
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
        // Each result as the server wrote it, less the frame around it.
        for (const change of message.modifications) {
          query(paths.get(change.queryId) ?? "(unknown query)").resultBytes +=
            Buffer.byteLength(JSON.stringify(change));
        }
      });
    });

    await page.goto(probe.path(), { waitUntil: "load" });
    // The HMR socket opens as the page boots, before any wait below can time
    // out on a cold `next dev` compile.
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

    // A page whose socket never opened must not pass as a lighter one.
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
  if (RECORD) {
    writeFileSync(BUDGET_FILE, `${JSON.stringify(measured, null, 2)}\n`);

    return;
  }

  const budget: Partial<Record<string, WireLoad>> = JSON.parse(
    readFileSync(BUDGET_FILE, "utf8"),
  );
  for (const [name, load] of Object.entries(measured)) {
    const allowed = budget[name];
    if (!allowed) {
      throw new Error(
        `${name}: no wire budget; record one with E2E_RECORD_WIRE_BUDGET=1`,
      );
    }
    const heaviest = Object.entries(byQuery[name])
      .slice(0, 5)
      .map(
        ([path, wire]) =>
          `${path} ${wire.subscriptions}x ${wire.resultBytes} B`,
      )
      .join(", ");
    // Soft, so one run names every page over its budget.
    expect
      .soft(
        load.subscriptions,
        `${name}: Convex query subscriptions on a cold load (heaviest: ${heaviest})`,
      )
      .toBeLessThanOrEqual(allowed.subscriptions);
    expect
      .soft(
        load.resultBytes,
        `${name}: Convex result bytes on a cold load, ${allowed.resultBytes} B + ${Math.round((BYTES_HEADROOM - 1) * 100)}% (heaviest: ${heaviest})`,
      )
      .toBeLessThanOrEqual(Math.floor(allowed.resultBytes * BYTES_HEADROOM));
    // Lower by more than the headroom, so run-to-run noise asks for nothing.
    if (
      load.subscriptions < allowed.subscriptions ||
      load.resultBytes * BYTES_HEADROOM < allowed.resultBytes
    ) {
      console.log(
        `${name}: under the wire budget (${allowed.subscriptions} subscriptions, ${allowed.resultBytes} B of results); record with E2E_RECORD_WIRE_BUDGET=1 to lock the gain in`,
      );
    }
  }
});
