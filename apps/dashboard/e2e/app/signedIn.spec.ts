import { expect, test, type Request } from "@playwright/test";
import {
  CANVAS_READY,
  hasProbe,
  MISSING_PROBE,
  readProjectId,
} from "../lib/session";

test.skip(!hasProbe(), MISSING_PROBE);

test("the home route opens the caller's project @rollout", async ({ page }) => {
  const settingsFetches: string[] = [];
  page.on("request", (request: Request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/settings/")) settingsFetches.push(pathname);
  });

  await page.goto("/");
  await page.waitForURL(new RegExp(`/${readProjectId()}(\\?|$)`));
  await expect(page.locator(CANVAS_READY)).toBeVisible();
  expect(settingsFetches, "home prefetches no account page").toEqual([]);
});

// @rollout: the canvas reads agent.config.canvasBadges, which dev has only after the merge.
test("a cold project load is one document, no server action, no logo fetch @rollout", async ({
  page,
}) => {
  const requests: Request[] = [];
  page.on("request", (request: Request) => requests.push(request));

  await page.goto(`/${readProjectId()}`);
  await page.locator(CANVAS_READY).waitFor();
  // A history write on load would discard a header click made meanwhile.
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
  // A full prefetch has no prefetch header, but the page's own route is never prefetched.
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
  const sent: string[] = [];
  page.on("websocket", (socket) => {
    if (!/\/api\/[^/]+\/sync$/.test(new URL(socket.url()).pathname)) return;
    socket.on("framesent", (frame) => sent.push(String(frame.payload)));
  });
  const subscribed = (udfPath: string): boolean =>
    sent.some((payload) => payload.includes(`"udfPath":"${udfPath}"`));

  await page.goto(`/${readProjectId()}/settings`);
  // The stage name is a query result: by now every query the shell mounts with has gone out.
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

test("the API access panel shows the gateway it reaches as the base URL @rollout", async ({
  page,
}) => {
  await page.goto("/settings/org?tab=api-access&sel=account");
  await expect(
    page.getByRole("button", { name: /^Base URL\s*https?:\/\/\S+$/ }),
  ).toBeVisible();
  await expect(page.getByText(/Set NEXT_PUBLIC_BROODS_BASE_URL/)).toHaveCount(
    0,
  );
});
