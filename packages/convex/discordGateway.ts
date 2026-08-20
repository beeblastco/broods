/**
 * The Discord gateway forwarder's view of the config plane.
 *
 * Discord only POSTs interactions (slash commands, buttons) to an
 * interactions endpoint; regular messages arrive over a Gateway WebSocket that
 * somebody has to hold. `apps/discord-forwarder` holds one socket per bot token
 * and POSTs each `MESSAGE_CREATE` to the agent's channel webhook.
 *
 * It needs two things and nothing else: the bot token to identify with, and the
 * webhook path to post to. Resolving that here — rather than shipping
 * `ACCOUNT_CONFIG_ENCRYPTION_SECRET` to a third process — keeps the decryption
 * key in the two places that already hold it, convex and core.
 */

import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { decryptAgentConfigBlob } from "./model/agentConfigCodec";
import { isPlainObject } from "./model/objects";
import { agentsInStage } from "./model/projectScope";

const discordConnectionValidator = v.object({
  accountId: v.string(),
  agentId: v.string(),
  agentName: v.string(),
  botToken: v.string(),
  endpointId: v.string(),
  /**
   * Path only. The forwarder joins it onto its own configured base URL, so the
   * config plane never has to know which gateway front door is in front of it.
   */
  webhookPath: v.string(),
});

/**
 * Every deployed agent that configures a Discord bot token, one row per agent.
 *
 * Walks active deployments rather than the whole `agents` table: a deployment
 * row is what mints an `endpointId`, and an agent with no deployed stage has no
 * webhook URL to forward to. Agents whose Discord config carries no `botToken`
 * are interaction-only and cannot be identified with, so they are absent.
 */
export const listConnections = internalQuery({
  args: {},
  returns: v.array(discordConnectionValidator),
  handler: async (ctx) => {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) {
      throw new Error(
        "ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to read Discord bot tokens",
      );
    }

    const deployments = await ctx.db.query("agentDeployments").collect();
    const connections: Array<{
      accountId: string;
      agentId: string;
      agentName: string;
      botToken: string;
      endpointId: string;
      webhookPath: string;
    }> = [];

    for (const deployment of deployments) {
      if (deployment.status !== "active") continue;
      const stage = await ctx.db.get(deployment.stageId);
      if (!stage) continue;
      const agents = await agentsInStage(
        ctx,
        { projectId: deployment.projectId, stageId: deployment.stageId },
        deployment.accountId,
      );

      for (const agent of agents) {
        const botToken = await discordBotToken(agent, secret);
        if (!botToken) continue;
        connections.push({
          accountId: deployment.accountId,
          agentId: agent._id,
          agentName: agent.name,
          botToken: botToken,
          endpointId: deployment.endpointId,
          webhookPath: webhookPath(
            deployment.accountId,
            deployment.endpointId,
            stage,
          ),
        });
      }
    }

    return connections;
  },
});

/** The agent's configured Discord bot token, or null when it has none. */
async function discordBotToken(
  agent: Doc<"agents">,
  secret: string,
): Promise<string | null> {
  if (!agent.encryptedConfig || !agent.encryptionIv || !agent.encryptionTag) {
    return null;
  }

  const config = await decryptAgentConfigBlob(
    {
      ciphertext: agent.encryptedConfig,
      iv: agent.encryptionIv,
      tag: agent.encryptionTag,
    },
    secret,
  );
  if (!config) return null;

  const channels = config.channels;
  if (!isPlainObject(channels)) return null;
  const discord = channels.discord;
  if (!isPlainObject(discord)) return null;

  return typeof discord.botToken === "string" && discord.botToken
    ? discord.botToken
    : null;
}

/**
 * Mirrors the webhook URL the CLI generates in `packages/broods/src/codegen.ts`:
 * production keeps the bare path, every other stage is addressed through its own
 * `endpointId` so two stages of one account never contend for a delivery.
 */
function webhookPath(
  accountId: string,
  endpointId: string,
  stage: Doc<"stages">,
): string {
  const account = encodeURIComponent(accountId);
  if (stage.kind === undefined || stage.kind === "production") {
    return `/webhooks/${account}/discord`;
  }

  return `/webhooks/${account}/dev/${encodeURIComponent(endpointId)}/discord`;
}
