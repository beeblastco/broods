/**
 * Environment for the forwarder process. Every knob has a default that is safe
 * in a single-replica deployment; the only required value is the base URL of the
 * gateway the channel webhooks live behind.
 */

import { positiveIntegerEnv, requireEnv } from "../../core/src/shared/env.ts";

// GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT (33281). Message Content is
// privileged: without the portal toggle Discord rejects IDENTIFY with 4014.
export const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

export interface ForwarderConfig {
  /** Ceiling on reconnect backoff. The IDENTIFY budget's first line of defence. */
  backoffCeilingMs: number;
  /** IDENTIFY calls allowed per bot token per window; see `identify-budget.ts`. */
  identifyLimit: number;
  pollIntervalMs: number;
  port: number;
  /** Gateway front door the channel webhooks live behind, no trailing slash. */
  webhookBaseUrl: string;
}

export function forwarderConfigFromEnv(): ForwarderConfig {
  return {
    backoffCeilingMs: positiveIntegerEnv("DISCORD_BACKOFF_CEILING_MS", 300_000),
    // Half of Discord's 1000, which leaves room for a restart to forget the count.
    identifyLimit: positiveIntegerEnv("DISCORD_IDENTIFY_LIMIT", 500),
    pollIntervalMs: positiveIntegerEnv("DISCORD_POLL_INTERVAL_MS", 30_000),
    port: positiveIntegerEnv("PORT", 3000),
    webhookBaseUrl: requireEnv("BROODS_WEBHOOK_BASE_URL").replace(/\/+$/, ""),
  };
}
