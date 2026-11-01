/**
 * Signed-in behaviour against a real Convex and WorkOS, on a deployment or a
 * local server pointed at the self-hosted backend. The first paths a user
 * walks, with the load-time wiring that has regressed before pinned by
 * assertion rather than by timing.
 */
import { expect, test, type Request } from "@playwright/test";
import {
  CANVAS_READY,
  hasProbe,
  MISSING_PROBE,
  readProjectId,
} from "../lib/session";

test.skip(!hasProbe(), MISSING_PROBE);

// @rollout: the pull request run serves this build against the dev backend,
// which may not have the Convex functions the home route calls until the
// merge deploys them. e2e-dashboard.yaml runs it after the rollout.
test("the home route opens the caller's project @rollout", async ({ page }) => {
  const settingsFetches: string[] = [];
  page.on("request", (request: Request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/settings/")) settingsFetches.push(pathname);
  });

  await page.goto("/");
  await page.waitForURL(new RegExp(`/${readProjectId()}(\\?|$)`));
  await expect(page.locator(CANVAS_READY)).toBeVisible();
  // Home only redirects: its account links compete with the project's own
  // chunks if they prefetch.
  expect(settingsFetches, "home prefetches no account page").toEqual([]);
});

test("a cold project load is one document, no server action, no logo fetch", async ({
  page,
}) => {
  const requests: Request[] = [];
  page.on("request", (request: Request) => requests.push(request));

  await page.goto(`/${readProjectId()}`);
  await page.locator(CANVAS_READY).waitFor();
  // The header shows the default stage selected, and the URL stays bare: a
  // history write on load would discard a header click made meanwhile.
  await expect(page.getByRole("button", { name: "Development" })).toBeVisible();
  expect(page.url()).not.toContain("stage=");

  const urls = (keep: (request: Request) => boolean): string[] =>
    requests.filter(keep).map((request) => request.url());
  expect(
    urls((request) => request.resourceType() === "document"),
    "one document per cold load",
  ).toHaveLength(1);
  expect(
    urls((request) => "next-action" in request.headers()),
    "the session resolves on the server",
  ).toEqual([]);
  // The header prefetches every other route in full, and a full prefetch
  // carries no prefetch marker, so it is told from a refetch by its path:
  // the page's own route is never prefetched in full.
  const ownPath = new URL(page.url()).pathname;
  expect(
    urls(
      (request) =>
        request.headers()["rsc"] === "1" &&
        !request.headers()["next-router-prefetch"] &&
        new URL(request.url()).pathname === ownPath,
    ),
    "the stage param must not refetch the route",
  ).toEqual([]);
  expect(
    urls((request) => request.url().includes("/assets/logo/")),
    "the logo is inline",
  ).toEqual([]);
});

test("a page off the canvas subscribes to no palette data until the palette is wanted", async ({
  page,
}) => {
  // Every query the client adds is a frame it sends on the Convex sync socket.
  const sent: string[] = [];
  page.on("websocket", (socket) => {
    if (!/\/api\/[^/]+\/sync$/.test(new URL(socket.url()).pathname)) return;
    socket.on("framesent", (frame) => sent.push(String(frame.payload)));
  });
  const subscribed = (udfPath: string): boolean =>
    sent.some((payload) => payload.includes(`"udfPath":"${udfPath}"`));

  await page.goto(`/${readProjectId()}/settings`);
  // The stage name is a query result, so the socket is live and every query
  // the shell asks for on mount has gone out by now.
  await expect(page.getByRole("button", { name: "Development" })).toBeVisible();
  expect(
    subscribed("canvas:getByProject"),
    "the canvas layout waits for the palette",
  ).toBe(false);
  expect(
    subscribed("agent/crons:listForProject"),
    "the crons wait for the palette",
  ).toBe(false);

  await page.locator("[data-palette-trigger]").click();
  await expect(page.getByRole("dialog")).toContainText("Go to");
  await expect
    .poll(() => subscribed("canvas:getByProject"), {
      message: "opening the palette subscribes its rows",
    })
    .toBe(true);
});

test("a segment that is no project id is the not-found page", async ({
  page,
}) => {
  await page.goto("/not-a-project");
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back to projects" }),
  ).toBeVisible();
});

// @rollout: the panel reads the key list and the viewer's permissions, which
// the dev backend has only once this build's Convex functions deploy.
test("the API access panel shows the gateway it reaches as the base URL @rollout", async ({
  page,
}) => {
  // The account key's detail panel holds the Base URL copy row, never the
  // warning shown when the stage has no gateway URL.
  await page.goto("/settings/org?tab=api-access&sel=account");
  await expect(
    page.getByRole("button", { name: /^Base URL\s*https?:\/\/\S+$/ }),
  ).toBeVisible();
  await expect(page.getByText(/Set NEXT_PUBLIC_BROODS_BASE_URL/)).toHaveCount(
    0,
  );
});
