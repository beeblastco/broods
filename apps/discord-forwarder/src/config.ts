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
  backoffBaseMs: number;
  /** Ceiling on reconnect backoff. The IDENTIFY budget's first line of defence. */
  backoffCeilingMs: number;
  /** IDENTIFY calls allowed per bot token per `identifyWindowMs`. */
  identifyLimit: number;
  identifyWindowMs: number;
  pollIntervalMs: number;
  port: number;
  /** Gateway front door the channel webhooks live behind, no trailing slash. */
  webhookBaseUrl: string;
}

export function forwarderConfigFromEnv(): ForwarderConfig {
  return {
    backoffBaseMs: positiveIntegerEnv("DISCORD_BACKOFF_BASE_MS", 1_000),
    backoffCeilingMs: positiveIntegerEnv("DISCORD_BACKOFF_CEILING_MS", 300_000),
    // Discord resets the bot token after 1000 IDENTIFYs in 24h. Half of that
    // leaves room for a pod restart, which loses the in-process counter.
    identifyLimit: positiveIntegerEnv("DISCORD_IDENTIFY_LIMIT", 500),
    identifyWindowMs: positiveIntegerEnv(
      "DISCORD_IDENTIFY_WINDOW_MS",
      24 * 60 * 60 * 1_000,
    ),
    pollIntervalMs: positiveIntegerEnv("DISCORD_POLL_INTERVAL_MS", 30_000),
    port: positiveIntegerEnv("PORT", 3000),
    webhookBaseUrl: requireEnv("BROODS_WEBHOOK_BASE_URL").replace(/\/+$/, ""),
  };
}
