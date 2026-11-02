import type { ChannelConnection } from "@broods/convex/channel/connections";
import type { ConfigPlane } from "../../discord-forwarder/src/config.ts";
import { logWarn } from "../../discord-forwarder/src/log.ts";

export interface MatrixConnection {
  agentId: string;
  agentName: string;
  apiUrl: string;
  botToken: string;
  webhookUrl: string;
}

export function planeMatrixConnections(
  plane: ConfigPlane,
  rows: readonly ChannelConnection[],
): MatrixConnection[] {
  const connections: MatrixConnection[] = [];
  for (const row of rows) {
    // Rows stored before writes required https: every sync carries the access token.
    if (!row.apiUrl || !isHttpsUrl(row.apiUrl)) {
      logWarn("Matrix connection needs an https homeserver URL, skipped", {
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

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
