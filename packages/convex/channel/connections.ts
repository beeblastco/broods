/**
 * Where a channel's bot token and inbound webhook path live, for a process that
 * has to hold a connection open on the agent's behalf.
 *
 * Two callers, one per channel that cannot deliver a regular message over HTTP.
 * `apps/discord-forwarder`: Discord POSTs interactions (slash commands,
 * buttons) to an endpoint, but ordinary messages arrive only over a Gateway
 * WebSocket. `apps/matrix-forwarder`: Matrix has no webhooks at all, so it
 * long-polls `/sync` against the homeserver in `apiUrl`. Telegram, Slack, Zalo,
 * GitHub, Pancake, Messenger and Instagram all register a plain webhook URL and need nothing held
 * open, so they have no forwarder today. Slack Socket Mode or Telegram long
 * polling would want exactly this answer.
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
import { internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";
import { accountCipher, encryptionSecrets } from "../model/accountKeys";
import {
  channelEndpointBotToken,
  refreshAccountChannelEndpoints,
} from "../model/channelEndpoints";

const channelConnectionValidator = v.object({
  agentId: v.string(),
  agentName: v.string(),
  /** The channel's API base URL, when set. Matrix always sets its homeserver. */
  apiUrl: v.optional(v.string()),
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
    // Without the secret this must throw before reading: an empty answer would
    // make the forwarder close every socket as "no agents configure it".
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

/** Rows a reconcile page reads before handing the rest to its next run. */
const RECONCILE_PAGE_SIZE = 256;

/**
 * Rebuilds the projection for every account that has an active deployment or a
 * stored row. The write seams keep the projection live; this hourly sweep is
 * the self-healing pass that repairs any seam a future writer forgets, so a
 * missed seam costs an hour of staleness, not a silent drift forever.
 *
 * One page of active deployments, then of stored rows, per run: each account
 * found is rebuilt in its own scheduled mutation, so no single transaction
 * holds the whole deployment table or every account's decrypts. An account
 * seen on two pages is rebuilt twice, which writes nothing the second time.
 */
export const reconcile = internalMutation({
  args: {
    source: v.optional(v.union(v.literal("deployments"), v.literal("stored"))),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const source = args.source ?? "deployments";
    const page =
      source === "deployments"
        ? await ctx.db
            .query("agentDeployments")
            .withIndex("by_status", (q) => q.eq("status", "active"))
            .paginate({
              cursor: args.cursor ?? null,
              numItems: RECONCILE_PAGE_SIZE,
            })
        : await ctx.db.query("channelEndpoints").paginate({
            cursor: args.cursor ?? null,
            numItems: RECONCILE_PAGE_SIZE,
          });
    const accountIds = new Set(page.page.map((row) => row.accountId));
    for (const accountId of accountIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.channel.connections.reconcileAccount,
        { accountId: accountId },
      );
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.channel.connections.reconcile, {
        source: source,
        cursor: page.continueCursor,
      });
    } else if (source === "deployments") {
      await ctx.scheduler.runAfter(0, internal.channel.connections.reconcile, {
        source: "stored",
      });
    }

    return accountIds.size;
  },
});

/** One account's share of the hourly reconcile. */
export const reconcileAccount = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await refreshAccountChannelEndpoints(ctx, args.accountId);

    return null;
  },
});
