// Bot tokens for forwarders that hold a socket open (Discord Gateway, Matrix /sync). Resolved
// here so ACCOUNT_CONFIG_ENCRYPTION_SECRET stays in convex and core, not a third process.

import { v, type Infer } from "convex/values";
import { internalQuery } from "../_generated/server";
import { accountCipher, encryptionSecrets } from "../model/accountKeys";
import { channelEndpointBotToken } from "../model/channelEndpoints";

const channelConnectionValidator = v.object({
  agentId: v.string(),
  agentName: v.string(),
  apiUrl: v.optional(v.string()),
  botToken: v.string(),
  // Path only: the caller joins it onto its own base URL.
  webhookPath: v.string(),
});

export type ChannelConnection = Infer<typeof channelConnectionValidator>;

// Reads the small channelEndpoints projection so the forwarder's subscription replays only
// when a channel connection changes, not on every agent write.
export const listConnections = internalQuery({
  args: { channel: v.string() },
  returns: v.array(channelConnectionValidator),
  handler: async (ctx, args): Promise<ChannelConnection[]> => {
    // Throw before reading: an empty answer would make the forwarder close every socket.
    encryptionSecrets();
    const rows = await ctx.db
      .query("channelEndpoints")
      .withIndex("by_platform", (q) => q.eq("platform", args.channel))
      .collect();
    const connections: ChannelConnection[] = [];
    for (const row of rows) {
      const botToken = await channelEndpointBotToken(
        row,
        await accountCipher(ctx, row.accountId),
      );
      if (!botToken) continue;
      connections.push({
        agentId: row.agentId,
        agentName: row.agentName,
        apiUrl: row.apiUrl,
        botToken: botToken,
        webhookPath: row.webhookPath,
      });
    }

    return connections;
  },
});
