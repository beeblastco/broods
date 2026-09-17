/**
 * Resolves the config plane's `matrix` rows. The subscription itself is
 * `watchChannelConnections` in `apps/discord-forwarder`; only the row shape
 * differs, because a Matrix account also names its homeserver.
 */

import type { ChannelConnection } from "@broods/convex/channel/connections";
import type { ConfigPlane } from "../../discord-forwarder/src/config.ts";
import { logWarn } from "../../discord-forwarder/src/log.ts";

/** A config-plane row with its homeserver and its plane's gateway joined on. */
export interface MatrixConnection {
  agentId: string;
  agentName: string;
  apiUrl: string;
  botToken: string;
  webhookUrl: string;
}

/**
 * Joins each webhook path onto the plane's own gateway. A row without a
 * homeserver cannot sync, so it is skipped and logged rather than started.
 */
export function planeMatrixConnections(
  plane: ConfigPlane,
  rows: readonly ChannelConnection[],
): MatrixConnection[] {
  const connections: MatrixConnection[] = [];
  for (const row of rows) {
    if (!row.apiUrl) {
      logWarn("Matrix connection has no homeserver URL, skipped", {
        agentId: row.agentId,
        agentName: row.agentName,
        plane: plane.name,
      });
      continue;
    }
    connections.push({
      agentId: row.agentId,
      agentName: row.agentName,
      apiUrl: row.apiUrl,
      botToken: row.botToken,
      webhookUrl: `${plane.webhookBaseUrl}${row.webhookPath}`,
    });
  }

  return connections;
}
