/**
 * Clock helpers for the render-budget probe (`e2e/perf`): wait for a page's
 * ready marker without rounding the timing up, time a client-side navigation
 * on the document's own clock, and record how long the main thread blocks.
 */
import {
  expect,
  type JSHandle,
  type Locator,
  type Page,
} from "@playwright/test";

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

/**
 * Starts recording the page's long tasks, every main-thread block of 50 ms or
 * more from here on. `jsonValue()` on the handle reads their durations so far.
 */
export async function watchLongTasks(page: Page): Promise<JSHandle<number[]>> {
  return await page.evaluateHandle(() => {
    const durations: number[] = [];
    new PerformanceObserver((list) => {
      durations.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ type: "longtask" });

    return durations;
  });
}
