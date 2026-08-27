/**
 * Environment for the forwarder process. Every knob has a default that is safe
 * in a single-replica deployment; the only required value is the config-plane
 * list, which names the Convex deployments to read Discord connections from.
 */

import { positiveIntegerEnv, requireEnv } from "../../core/src/shared/env.ts";

// GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT (33281). Message Content is
// privileged: without the portal toggle Discord rejects IDENTIFY with 4014.
export const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

const PLANES_ENV = "BROODS_CONFIG_PLANES";
// A plane name becomes part of an env var name, so it is limited to what one can
// hold. Checked rather than sanitized: silently rewriting it would look up a key
// the operator never wrote.
const PLANE_NAME = /^[a-z0-9-]+$/i;

/** A plane with the admin credential its config-plane read needs. */
export interface ConfigPlane extends ConfigPlaneEntry {
  deployKey: string;
}

/** A plane as written in `BROODS_CONFIG_PLANES`, before its key is attached. */
export interface ConfigPlaneEntry {
  convexUrl: string;
  /** Log label, and the suffix of the env var holding this plane's deploy key. */
  name: string;
  /** Gateway front door this plane's webhooks live behind, no trailing slash. */
  webhookBaseUrl: string;
}

export interface ForwarderConfig {
  /** Ceiling on reconnect backoff. The IDENTIFY budget's first line of defence. */
  backoffCeilingMs: number;
  /** IDENTIFY calls allowed per bot token per window; see `identify-budget.ts`. */
  identifyLimit: number;
  /**
   * Every config plane this process serves, not one per stage.
   *
   * One socket per bot token is a property of the token, not of a deployment, so
   * two forwarders that ever saw the same token would each hold a socket for it
   * and every message would be answered twice. A single process reading every
   * plane cannot: `supervisor.ts` keys sockets by token, so the same token in two
   * planes is one socket fanning out to both webhooks.
   */
  planes: ConfigPlane[];
  port: number;
}

export function forwarderConfigFromEnv(): ForwarderConfig {
  return {
    backoffCeilingMs: positiveIntegerEnv("DISCORD_BACKOFF_CEILING_MS", 300_000),
    // Half of Discord's 1000, which leaves room for a restart to forget the count.
    identifyLimit: positiveIntegerEnv("DISCORD_IDENTIFY_LIMIT", 500),
    planes: configPlanesEnv(),
    port: positiveIntegerEnv("PORT", 3000),
  };
}

/**
 * Validated at startup, not at first use. Both URLs in a plane are dialled or
 * POSTed to, and `requireEnv` only ever proved presence: a value `new URL`
 * rejects would start cleanly and then fail every forwarded message, which reads
 * as Discord being broken rather than as a bad config.
 */
export function parseConfigPlanes(raw: string): ConfigPlaneEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${PLANES_ENV} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${PLANES_ENV} must be a non-empty JSON array`);
  }

  const planes = parsed.map((entry: unknown): ConfigPlaneEntry => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${PLANES_ENV} entries must be objects`);
    }
    // The one cast in this file, at the boundary where operator-written JSON
    // becomes typed: every value stays `unknown` and is checked below.
    const record = entry as Partial<Record<keyof ConfigPlaneEntry, unknown>>;
    const name = record.name;
    if (typeof name !== "string" || !PLANE_NAME.test(name)) {
      throw new Error(
        `${PLANES_ENV} plane names must match ${PLANE_NAME.source}, got ${JSON.stringify(name)}`,
      );
    }

    return {
      convexUrl: planeUrl(name, "convexUrl", record.convexUrl),
      name: name,
      webhookBaseUrl: planeUrl(name, "webhookBaseUrl", record.webhookBaseUrl),
    };
  });

  // Two planes under one name read one deploy key and would forward every row of
  // that deployment twice, to the same webhook, from the same socket.
  if (
    new Set(planes.map((plane): string => plane.name)).size !== planes.length
  ) {
    throw new Error(`${PLANES_ENV} has duplicate plane names`);
  }

  return planes;
}

/**
 * Deploy keys stay out of the plane list because that list lives in a Helm values
 * file and they are secrets. Each plane names its own key by convention instead,
 * so serving one more Convex deployment is one list entry and one secret key
 * rather than a code change.
 */
function configPlanesEnv(): ConfigPlane[] {
  return parseConfigPlanes(requireEnv(PLANES_ENV)).map(
    (plane): ConfigPlane => ({
      convexUrl: plane.convexUrl,
      deployKey: requireEnv(deployKeyEnvName(plane.name)),
      name: plane.name,
      webhookBaseUrl: plane.webhookBaseUrl,
    }),
  );
}

/** Plane `dev` reads `CONVEX_DEPLOY_KEY_DEV`. */
function deployKeyEnvName(plane: string): string {
  return `CONVEX_DEPLOY_KEY_${plane.toUpperCase().replace(/-/g, "_")}`;
}

function planeUrl(
  plane: string,
  field: keyof ConfigPlaneEntry,
  value: unknown,
): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${PLANES_ENV} plane ${plane} is missing ${field}`);
  }
  const trimmed = value.replace(/\/+$/, "");
  try {
    new URL(trimmed);
  } catch {
    throw new Error(
      `${PLANES_ENV} plane ${plane} has an invalid ${field}: ${JSON.stringify(value)}`,
    );
  }

  return trimmed;
}
