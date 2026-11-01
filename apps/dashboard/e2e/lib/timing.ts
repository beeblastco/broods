import {
  expect,
  type JSHandle,
  type Locator,
  type Page,
} from "@playwright/test";

const READY_TIMEOUT_MS = 30_000;
// A long task is reported only once it ends: wait this long before reading the durations.
export const LONG_TASK_SETTLE_MS = 250;

// `locator.waitFor` backs off to 500 ms polls, rounding timings up: poll every frame instead.
export async function waitForReady(marker: Locator): Promise<void> {
  await expect
    .poll(() => marker.first().isVisible(), {
      intervals: [16],
      timeout: READY_TIMEOUT_MS,
    })
    .toBe(true);
}

// performance.now() restarts with each document, so a navigation that loads a new one fails
// here rather than recording any number, negative included.
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

export async function watchLongTasks(page: Page): Promise<JSHandle<number[]>> {
  return await page.evaluateHandle(() => {
    const durations: number[] = [];
    new PerformanceObserver((list) => {
      durations.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ type: "longtask" });

    return durations;
  });
}
