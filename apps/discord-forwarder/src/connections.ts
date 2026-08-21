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

// ConvexHttpClient's typed `query` only accepts public function refs and the
// backend exposes this as an internalQuery, so the ref is cast at the boundary
// exactly as apps/core does. Deploy-key auth permits the call.
const internal: any = require("@broods/convex/_generated/api").internal;

// One client per plane for the life of the process. Rebuilding them every poll
// would re-run admin auth twice a minute forever for no gain.
const clients = new Map<string, ConvexHttpClient>();

/** A config-plane row with its own plane's gateway front door joined on. */
export interface ForwarderConnection {
  agentId: string;
  agentName: string;
  botToken: string;
  webhookUrl: string;
}

/**
 * One entry per deployed agent that configures a Discord bot token, across every
 * plane.
 *
 * Rejects if any plane fails rather than returning what the others answered. The
 * caller reconciles the socket set against this list, and reconciling a partial
 * one would read the failed plane's tokens as deleted and close their sockets —
 * spending IDENTIFY budget to reopen them on the next poll, for what is usually
 * a blip.
 */
export async function listDiscordConnections(
  planes: readonly ConfigPlane[],
): Promise<ForwarderConnection[]> {
  const perPlane = await Promise.all(
    planes.map(async (plane) =>
      planeConnections(
        plane,
        (await planeClient(plane).query(
          internal.channelConnections.listConnections,
          { channel: "discord" },
        )) as ChannelConnection[],
      ),
    ),
  );

  return perPlane.flat();
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
