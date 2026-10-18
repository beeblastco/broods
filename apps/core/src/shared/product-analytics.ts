/**
 * Opt-in product analytics from core: one `run_finished` per finished run,
 * posted straight to PostHog, fire and forget. Off unless `BROODS_ANALYTICS`
 * names a mode and `POSTHOG_KEY` is set. Never throws into the run and never
 * waits on the network. The event and what it may carry are listed in
 * `@broods/convex/model/productAnalytics`.
 */

import {
  analyticsBatch,
  analyticsMode,
  type AnalyticsEvent,
} from "@broods/convex/model/productAnalytics";
import { createHash } from "node:crypto";
import { optionalEnv } from "./env.ts";

const POSTHOG_DEFAULT_HOST = "https://eu.i.posthog.com";
const POST_TIMEOUT_MS = 2000;

/**
 * Send one event. `orgId` is the account the run belonged to, attached only
 * in `org` mode, which the managed service sets and a self-hosted install
 * does not.
 */
export function captureAnalytics(
  event: AnalyticsEvent,
  orgId: string | undefined,
): void {
  const mode = analyticsMode(optionalEnv("BROODS_ANALYTICS"));
  const apiKey = optionalEnv("POSTHOG_KEY");
  const convexUrl = optionalEnv("CONVEX_URL");
  if (mode === null || !apiKey || !convexUrl) return;

  const host = optionalEnv("POSTHOG_HOST") ?? POSTHOG_DEFAULT_HOST;
  void fetch(`${host}/batch/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      analyticsBatch([event], {
        apiKey: apiKey,
        instanceId: createHash("sha256")
          .update(convexUrl)
          .digest("hex")
          .slice(0, 16),
        ...(mode === "org" && orgId !== undefined ? { orgId: orgId } : {}),
        source: "core",
        at: Date.now(),
      }),
    ),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  }).catch(() => {});
}

/** `anthropic/claude-sonnet-4` from `claude-sonnet-4-20250514`: the id without its date or version tail. */
export function modelFamily(provider: string, modelId: string): string {
  return `${provider}/${modelId.replace(/[-@:]\d[\d.-]*$/, "")}`;
}
