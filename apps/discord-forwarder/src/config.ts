import { positiveIntegerEnv, requireEnv } from "../../core/src/shared/env.ts";

// GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT (33281). Message Content is
// privileged: without the portal toggle Discord rejects IDENTIFY with 4014.
export const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

const PLANES_ENV = "BROODS_CONFIG_PLANES";
// Part of an env var name; checked, not sanitized, so we never read a key nobody wrote.
const PLANE_NAME = /^[a-z0-9-]+$/i;

export interface ConfigPlane extends ConfigPlaneEntry {
  deployKey: string;
}

export interface ConfigPlaneEntry {
  convexUrl: string;
  name: string;
  webhookBaseUrl: string;
}

export interface ForwarderConfig {
  backoffCeilingMs: number;
  identifyLimit: number;
  // One process serves every plane: sockets are keyed by token, so a token in two planes is
  // one socket fanning out to both webhooks, never two sockets answering twice.
  planes: ConfigPlane[];
  port: number;
}

// Deploy keys are secrets, so they stay out of the Helm-values plane list; each plane names
// its key by convention. `apps/matrix-forwarder` reads the same list.
export function configPlanesEnv(): ConfigPlane[] {
  return parseConfigPlanes(requireEnv(PLANES_ENV)).map(
    (plane): ConfigPlane => ({
      convexUrl: plane.convexUrl,
      deployKey: requireEnv(deployKeyEnvName(plane.name)),
      name: plane.name,
      webhookBaseUrl: plane.webhookBaseUrl,
    }),
  );
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

// Checked at boot: a bad URL would otherwise start cleanly, then fail every forwarded message.
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

  // One name = one deploy key: every row of that deployment would be forwarded twice.
  if (
    new Set(planes.map((plane): string => plane.name)).size !== planes.length
  ) {
    throw new Error(`${PLANES_ENV} has duplicate plane names`);
  }

  return planes;
}

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
  if (!URL.canParse(trimmed)) {
    throw new Error(
      `${PLANES_ENV} plane ${plane} has an invalid ${field}: ${JSON.stringify(value)}`,
    );
  }

  return trimmed;
}
