/**
 * Clock helpers for the render-budget probe (`e2e/perf`): wait for a page's
 * ready marker without rounding the timing up, wait for a link to be
 * hydrated, and time a client-side navigation on the document's own clock.
 */
import { expect, type Locator, type Page } from "@playwright/test";

const READY_TIMEOUT_MS = 30_000;

/** Polls every frame: `locator.waitFor` backs off to 500 ms, rounding timings up to the next half second. */
export async function waitForReady(marker: Locator): Promise<void> {
  await expect
    .poll(() => marker.first().isVisible(), {
      intervals: [16],
      timeout: READY_TIMEOUT_MS,
    })
    .toBe(true);
}

/**
 * Waits until React has hydrated `element`, so a click on it reaches the app.
 * A server-rendered page paints its links before its JS has run, and until
 * then a link is a plain `<a>`: a click loads a new document, the browser's
 * fallback, not the client navigation the app does once hydrated. React keeps
 * a hydrated node's props on it under `__reactProps$<id>`.
 */
export async function waitForHydrated(element: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        element
          .first()
          .evaluate((node) =>
            Object.keys(node).some((key) => key.startsWith("__reactProps$")),
          ),
      { intervals: [16], timeout: READY_TIMEOUT_MS },
    )
    .toBe(true);
}

/**
 * Times one client-side navigation: `navigate` starts it, `marker` on screen
 * ends it. Both readings come from the document's `performance.now()`, which
 * counts from that document's own time origin, so the difference holds only
 * while the document stays the same. A navigation that loads a new document
 * (a reload, a redirect, a plain link) resets that clock and could record any
 * number, negative included; it fails here as a broken client navigation,
 * naming both documents, instead of passing as a fast one.
 */
export async function timeClientNavigation(
  page: Page,
  navigate: () => Promise<void>,
  marker: Locator,
): Promise<number> {
  const readClock = () =>
    page.evaluate(() => ({
      origin: performance.timeOrigin,
      now: performance.now(),
      path: location.pathname,
    }));
  const before = await readClock();
  await navigate();
  await waitForReady(marker);
  const after = await readClock();
  expect(
    after.origin,
    `client navigation ${before.path} -> ${after.path} loaded a new document`,
  ).toBe(before.origin);
  const ms = after.now - before.now;
  expect(
    Number.isFinite(ms) && ms >= 0,
    `navigation ${before.path} -> ${after.path} measured ${ms} ms`,
  ).toBe(true);

  return ms;
}
