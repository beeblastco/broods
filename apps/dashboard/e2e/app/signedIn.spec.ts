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

test("the home route opens the caller's project", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL(new RegExp(`/${readProjectId()}(\\?|$)`));
  await expect(page.locator(CANVAS_READY)).toBeVisible();
});

test("a cold project load is one document, no server action, no logo fetch", async ({
  page,
}) => {
  const requests: Request[] = [];
  page.on("request", (request: Request) => requests.push(request));

  await page.goto(`/${readProjectId()}`);
  await page.locator(CANVAS_READY).waitFor();
  // The default stage lands in the URL and the header shows it selected.
  await expect(page).toHaveURL(/[?&]stage=[a-z0-9]+/);
  await expect(page.getByRole("button", { name: "Development" })).toBeVisible();

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
  // Link prefetches carry the RSC header too; a route refetch is one without
  // the prefetch marker.
  expect(
    urls(
      (request) =>
        request.headers()["rsc"] === "1" &&
        !request.headers()["next-router-prefetch"],
    ),
    "the stage param must not refetch the route",
  ).toEqual([]);
  expect(
    urls((request) => request.url().includes("/assets/logo/")),
    "the wordmark is inline",
  ).toEqual([]);
});
