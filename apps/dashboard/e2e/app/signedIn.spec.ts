/**
 * Signed-in behaviour against a real Convex and WorkOS, on a deployment or a
 * local server pointed at the self-hosted backend. The first paths a user
 * walks, with the load-time wiring that has regressed before pinned by
 * assertion rather than by timing.
 */
import { expect, test, type Request } from "@playwright/test";
import { hasProbe, MISSING_PROBE, readProjectId } from "../lib/session";

test.skip(!hasProbe(), MISSING_PROBE);

test("the home route opens the caller's project", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL(new RegExp(`/${readProjectId()}(\\?|$)`));
  await expect(page.locator(".react-flow__viewport")).toBeVisible();
});

test("a cold project load is one document, no server action, no logo fetch", async ({
  page,
}) => {
  const documents: string[] = [];
  const serverActions: string[] = [];
  const routeRefetches: string[] = [];
  const logoImages: string[] = [];
  page.on("request", (request: Request) => {
    const headers = request.headers();
    if (request.resourceType() === "document") documents.push(request.url());
    if (headers["next-action"]) serverActions.push(request.url());
    // Link prefetches carry the RSC header too; a route refetch is one
    // without the prefetch marker.
    if (headers["rsc"] === "1" && !headers["next-router-prefetch"]) {
      routeRefetches.push(request.url());
    }
    if (request.url().includes("/assets/logo/")) logoImages.push(request.url());
  });

  await page.goto(`/${readProjectId()}`);
  await page.locator(".react-flow__viewport").waitFor();
  // The default stage lands in the URL and the header shows it selected.
  await expect(page).toHaveURL(/[?&]stage=[a-z0-9]+/);
  await expect(page.getByRole("button", { name: "Development" })).toBeVisible();

  expect(documents, "one document per cold load").toHaveLength(1);
  expect(serverActions, "the session resolves on the server").toEqual([]);
  expect(routeRefetches, "the stage param must not refetch the route").toEqual(
    [],
  );
  expect(logoImages, "the wordmark is inline").toEqual([]);
});
