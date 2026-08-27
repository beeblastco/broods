/**
 * Where a channel's bot token and inbound webhook path live, for a process that
 * has to hold a connection open on the agent's behalf.
 *
 * `apps/discord-forwarder` is the first and so far only caller, because Discord
 * is the only channel that cannot deliver a regular message over HTTP: it POSTs
 * interactions (slash commands, buttons) to an endpoint, but ordinary messages
 * arrive only over a Gateway WebSocket. Telegram, Slack, Zalo, GitHub and
 * Pancake all register a plain webhook URL and need nothing held open, so they
 * have no forwarder today. The query takes a channel name anyway: the read is
 * not Discord-shaped, and Slack Socket Mode or Telegram long polling would want
 * exactly this answer.
 *
 * The forwarder holds this query open as a subscription, so it reads the small
 * `channelEndpoints` projection (`model/channelEndpoints.ts` is its one writer)
 * rather than every deployment and agent blob: the subscription then replays
 * only when a channel connection actually changes, not on every agent write.
 *
 * Resolving tokens here rather than shipping `ACCOUNT_CONFIG_ENCRYPTION_SECRET`
 * to a third process keeps the decryption key in the two places that already
 * hold it, convex and core.
 */

import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  channelEndpointBotToken,
  refreshAccountChannelEndpoints,
} from "./model/channelEndpoints";

const channelConnectionValidator = v.object({
  agentId: v.string(),
  agentName: v.string(),
  botToken: v.string(),
  /**
   * Path only. The caller joins it onto its own configured base URL, so the
   * config plane never has to know which gateway front door is in front of it.
   */
  webhookPath: v.string(),
});

export type ChannelConnection = Infer<typeof channelConnectionValidator>;

/**
 * Every deployed agent that configures a bot token for `channel`, one row each,
 * straight off the projection.
 */
export const listConnections = internalQuery({
  args: { channel: v.string() },
  returns: v.array(channelConnectionValidator),
  handler: async (ctx, args): Promise<ChannelConnection[]> => {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) {
      throw new Error(
        "ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to read channel bot tokens",
      );
    }

    const rows = await ctx.db
      .query("channelEndpoints")
      .withIndex("by_platform", (q) => q.eq("platform", args.channel))
      .collect();
    const connections: ChannelConnection[] = [];
    for (const row of rows) {
      const botToken = await channelEndpointBotToken(row, secret);
      if (!botToken) continue;
      connections.push({
        agentId: row.agentId,
        agentName: row.agentName,
        botToken: botToken,
        webhookPath: row.webhookPath,
      });
    }

    return connections;
  },
});

/**
 * Rebuilds the projection for every account that has an active deployment or a
 * stored row. The write seams keep the projection live; this hourly sweep is
 * the self-healing pass that seeds it at cutover and repairs any seam a future
 * writer forgets, so a missed seam costs an hour of staleness, not a silent
 * drift forever.
 */
export const reconcile = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const deployments = await ctx.db
      .query("agentDeployments")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();
    const stored = await ctx.db.query("channelEndpoints").collect();
    const accountIds = new Set([
      ...deployments.map((deployment) => deployment.accountId),
      ...stored.map((row) => row.accountId),
    ]);
    for (const accountId of accountIds) {
      await refreshAccountChannelEndpoints(ctx, accountId);
    }

    return accountIds.size;
  },
});
