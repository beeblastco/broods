import type { PostHog } from "posthog-js";

/**
 * posthog-js, fetched once the page has loaded so it never competes with the
 * chunks the page needs: it is a fifth of every first load.
 * `instrumentation-client.ts` subscribes first, so `init` runs before any other
 * caller's capture. An error thrown before then is not captured, and a sign-out
 * in that moment skips the reset. Never settles on the server, where nothing
 * captures, nor when the chunk fails to load, so analytics then stays off.
 */
export const analytics: Promise<PostHog> =
  typeof window === "undefined" ? new Promise((): void => {}) : loadPosthog();

/** Imports posthog-js after the load event; a failed import never settles. */
async function loadPosthog(): Promise<PostHog> {
  await pageLoaded();
  try {
    return (await import("posthog-js")).default;
  } catch {
    return new Promise((): void => {});
  }
}

/** Resolves once the window's load event has fired. */
function pageLoaded(): Promise<void> {
  return new Promise((resolve): void => {
    if (document.readyState === "complete") resolve();
    else window.addEventListener("load", (): void => resolve(), { once: true });
  });
}
