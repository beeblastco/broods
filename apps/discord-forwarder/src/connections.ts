/**
 * Reads Discord connections from every config plane the process serves.
 *
 * `packages/convex/channelConnections.ts` does the decryption, so this process
 * never holds `ACCOUNT_CONFIG_ENCRYPTION_SECRET` — only one deploy key per plane,
 * the same credential core authenticates storage reads with. That query is not
 * Discord-specific; this is the caller that asks it for `discord`.
 */

import type { ChannelConnection } from "@broods/convex/channelConnections";
import type { ConvexHttpClient } from "convex/browser";
import { createConvexClient } from "../../core/src/shared/convex/client.ts";
import type { ConfigPlane } from "./config.ts";
import { logWarn } from "./log.ts";

// ConvexHttpClient's typed `query` only accepts public function refs and the
// backend exposes this as an internalQuery, so the ref is cast at the boundary
// exactly as apps/core does. Deploy-key auth permits the call.
const internal: any = require("@broods/convex/_generated/api").internal;

// One client per plane for the life of the process. Rebuilding them every poll
// would re-run admin auth twice a minute forever for no gain.
const clients = new Map<string, ConvexHttpClient>();

// The last answer each plane gave, by plane name. A plane that fails a poll
// reuses this instead of reporting nothing, so a blip cannot look like "every
// token here was deleted" and close its sockets.
const lastGood = new Map<string, ForwarderConnection[]>();

/** A config-plane row with its own plane's gateway front door joined on. */
export interface ForwarderConnection {
  agentId: string;
  agentName: string;
  botToken: string;
  webhookUrl: string;
}

/**
 * Flattens what the planes answered, treating a silent plane as contributing
 * nothing rather than as an outage. Throws only when every plane was silent,
 * which is the one case the caller must not reconcile on.
 *
 * Separate from the read so the rule is pinned by a test: getting it wrong once
 * meant a backend that was not live yet stopped every other plane from ever
 * opening a socket.
 */
export function combinePlaneAnswers(
  planeNames: readonly string[],
  answers: readonly (ForwarderConnection[] | null)[],
): ForwarderConnection[] {
  // `every` is true for an empty list too, which is the right answer: a process
  // with no planes has nothing to poll and must not report itself ready.
  if (answers.every((answer) => answer === null)) {
    throw new Error(`No config plane answered: ${planeNames.join(", ")}`);
  }

  return answers.flatMap((answer) => answer ?? []);
}

/**
 * One entry per deployed agent that configures a Discord bot token, across every
 * plane.
 *
 * A plane is isolated from its neighbours: one that fails contributes whatever
 * it last answered, so its sockets survive the blip while every healthy plane
 * still reconciles. A plane that has never answered contributes nothing, which
 * is what lets this process serve a deployment whose backend is not live yet.
 *
 * Rejects only when no plane answered at all. The caller leaves readiness false
 * and skips the reconcile entirely on a rejection, so total failure never reads
 * as "every token was deleted" either.
 */
export async function listDiscordConnections(
  planes: readonly ConfigPlane[],
): Promise<ForwarderConnection[]> {
  return combinePlaneAnswers(
    planes.map((plane) => plane.name),
    await Promise.all(planes.map(planeConnectionsOrLastGood)),
  );
}

/**
 * Resolves a plane's rows against its own gateway. The config plane returns a
 * path and never learns which front door sits in front of it, which is what lets
 * one process serve deployments that answer on different hosts.
 */
export function planeConnections(
  plane: ConfigPlane,
  rows: readonly ChannelConnection[],
): ForwarderConnection[] {
  return rows.map((row) => ({
    agentId: row.agentId,
    agentName: row.agentName,
    botToken: row.botToken,
    webhookUrl: `${plane.webhookBaseUrl}${row.webhookPath}`,
  }));
}

function planeClient(plane: ConfigPlane): ConvexHttpClient {
  const cached = clients.get(plane.convexUrl);
  if (cached) return cached;
  const client = createConvexClient(plane.convexUrl, plane.deployKey);
  clients.set(plane.convexUrl, client);

  return client;
}

/** This plane's connections, or null when it has never answered. */
async function planeConnectionsOrLastGood(
  plane: ConfigPlane,
): Promise<ForwarderConnection[] | null> {
  try {
    const rows = (await planeClient(plane).query(
      internal.channelConnections.listConnections,
      { channel: "discord" },
    )) as ChannelConnection[];
    const resolved = planeConnections(plane, rows);
    lastGood.set(plane.name, resolved);

    return resolved;
  } catch (error) {
    logWarn("Config plane poll failed", {
      error: error instanceof Error ? error.message : String(error),
      plane: plane.name,
      reusing: lastGood.get(plane.name)?.length ?? 0,
    });

    return lastGood.get(plane.name) ?? null;
  }
}
