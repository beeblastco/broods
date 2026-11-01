import type { PostHog } from "posthog-js";

// Loaded after the load event: posthog-js is a fifth of every first load. Never settles on the
// server or when the chunk fails, so analytics stays off. instrumentation-client.ts inits first.
export const analytics: Promise<PostHog> =
  typeof window === "undefined" ? new Promise((): void => {}) : loadPosthog();

async function loadPosthog(): Promise<PostHog> {
  await pageLoaded();
  try {
    return (await import("posthog-js")).default;
  } catch {
    return new Promise((): void => {});
  }
}

function pageLoaded(): Promise<void> {
  return new Promise((resolve): void => {
    if (document.readyState === "complete") resolve();
    else window.addEventListener("load", (): void => resolve(), { once: true });
  });
}
