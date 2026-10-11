/**
 * Controls for the probe's navigation clock, on two throwaway documents the
 * browser serves itself (no server, no account). A link that loads a new
 * document resets `performance.now()`, and the probe once recorded such a
 * navigation as -451 ms, inside budget. It must fail instead, while a real
 * client-side navigation is timed on one unbroken clock.
 */
import { expect, test, type Page } from "@playwright/test";
import { timeClientNavigation } from "../lib/timing";

const ORIGIN = "http://navigation-clock.test";
// The client navigation renders its page this long after the click.
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
  // The probe's own start document has been open for seconds; the new one's
  // clock starts at zero, so the raw difference would come out negative.
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
