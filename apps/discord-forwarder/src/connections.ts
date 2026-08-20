/**
 * Reads Discord connections from the config plane.
 *
 * `packages/convex/discordGateway.ts` does the decryption, so this process never
 * holds `ACCOUNT_CONFIG_ENCRYPTION_SECRET` — only a Convex deploy key, the same
 * credential core authenticates storage reads with.
 */

import { getConvexClient } from "../../core/src/shared/convex/client.ts";

// ConvexHttpClient's typed `query` only accepts public function refs and the
// backend exposes this as an internalQuery, so the ref is cast at the boundary
// exactly as apps/core does. Deploy-key auth permits the call.
const internal: any = require("@broods/convex/_generated/api").internal;

export interface DiscordConnection {
  agentId: string;
  agentName: string;
  botToken: string;
  webhookPath: string;
}

/** One entry per deployed agent that configures a Discord bot token. */
export async function listDiscordConnections(): Promise<DiscordConnection[]> {
  return (await getConvexClient().query(
    internal.discordGateway.listConnections,
    {},
  )) as DiscordConnection[];
}
