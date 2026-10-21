import type { PostHog } from "posthog-js";

/**
 * posthog-js, fetched once the page has loaded so it never competes with the
 * chunks the page needs: it is a fifth of every first load.
 * `instrumentation-client.ts` subscribes first, so `init` runs before any other
 * caller's capture. An error thrown before then is not captured. Never resolves
 * on the server, where nothing captures.
 */
export const analytics: Promise<PostHog> =
  typeof window === "undefined"
    ? new Promise((): void => {})
    : pageLoaded()
        .then(() => import("posthog-js"))
        .then((mod) => mod.default);

function pageLoaded(): Promise<void> {
  return new Promise((resolve): void => {
    if (document.readyState === "complete") resolve();
    else window.addEventListener("load", () => resolve(), { once: true });
  });
}
