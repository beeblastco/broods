import { expect, test, type Page } from "@playwright/test";
import { timeClientNavigation } from "../lib/timing";

const ORIGIN = "http://navigation-clock.test";
const CLIENT_RENDER_MS = 50;

const PAGES: Record<string, string> = {
  "/": `<a href="/next">Next</a>
<script>
  document.querySelector("a").addEventListener("click", (event) => {
    if (!location.search.includes("client")) return;
    event.preventDefault();
    history.pushState(null, "", "/next");
    setTimeout(() => {
      document.body.innerHTML = "<h1>Next</h1>";
    }, ${CLIENT_RENDER_MS});
  });
</script>`,
  "/next": "<h1>Next</h1>",
};

async function openStart(page: Page, query: string): Promise<void> {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>${PAGES[new URL(route.request().url()).pathname] ?? ""}</body></html>`,
    }),
  );
  await page.goto(`${ORIGIN}/${query}`);
}

test("a navigation that loads a new document fails the clock", async ({
  page,
}) => {
  await openStart(page, "");
  // Age the start document's clock, so the new document's reset would read negative.
  await page.waitForTimeout(500);

  await expect(
    timeClientNavigation(
      page,
      () => page.getByRole("link", { name: "Next" }).click(),
      page.getByRole("heading", { name: "Next" }),
    ),
  ).rejects.toThrow(/\/ -> \/next loaded a new document/);
});

test("a client-side navigation is timed on one clock", async ({ page }) => {
  await openStart(page, "?client");

  const ms = await timeClientNavigation(
    page,
    () => page.getByRole("link", { name: "Next" }).click(),
    page.getByRole("heading", { name: "Next" }),
  );

  expect(ms).toBeGreaterThanOrEqual(CLIENT_RENDER_MS - 5);
  expect(ms).toBeLessThan(5_000);
});
