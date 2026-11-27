import type { PostHog } from "posthog-js";

import { afterLoad } from "@/app/lib/prefetch";

// Loaded at background priority after load: posthog-js is a fifth of every first load. Never
// settles on the server or when the chunk fails, so analytics stays off. instrumentation-client.ts
// inits first.
export const analytics: Promise<PostHog> =
  typeof window === "undefined" ? new Promise((): void => {}) : loadPosthog();

async function loadPosthog(): Promise<PostHog> {
  await new Promise<void>((resolve): void => void afterLoad(resolve));
  try {
    return (await import("posthog-js")).default;
  } catch {
    return new Promise((): void => {});
  }
}
