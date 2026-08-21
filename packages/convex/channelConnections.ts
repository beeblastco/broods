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
 * Resolving it here rather than shipping `ACCOUNT_CONFIG_ENCRYPTION_SECRET` to a
 * third process keeps the decryption key in the two places that already hold it,
 * convex and core.
 */

import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { decryptAgentConfigBlob } from "./model/agentConfigCodec";
import { agentsInStage } from "./model/projectScope";

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
 * The slice of a decrypted agent config this file reads. The stored blob is
 * `Record<string, unknown>`, so this is the shape we assert at the one boundary
 * where it is read; every field stays optional and unknown-typed, and the caller
 * checks the one value it uses.
 */
interface ChannelConfigView {
  channels?: Record<string, { botToken?: unknown } | undefined>;
}

/**
 * Every deployed agent that configures a bot token for `channel`, one row each.
 *
 * Walks active deployments rather than the whole `agents` table: a deployment
 * row is what mints an `endpointId`, and an agent with no deployed stage has no
 * webhook URL to forward to. An agent whose channel config carries no `botToken`
 * cannot authenticate a connection, so it is absent.
 */
export const listConnections = internalQuery({
  args: { channel: v.string() },
  returns: v.array(channelConnectionValidator),
  handler: async (ctx, args) => {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) {
      throw new Error(
        "ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to read channel bot tokens",
      );
    }

    const deployments = await ctx.db.query("agentDeployments").collect();
    const connections: ChannelConnection[] = [];

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
        const botToken = await channelBotToken(agent, args.channel, secret);
        if (!botToken) continue;
        connections.push({
          agentId: agent._id,
          agentName: agent.name,
          botToken: botToken,
          webhookPath: webhookPath(
            deployment.accountId,
            deployment.endpointId,
            args.channel,
            stage,
          ),
        });
      }
    }

    return connections;
  },
});

/** The agent's configured bot token for `channel`, or null when it has none. */
async function channelBotToken(
  agent: Doc<"agents">,
  channel: string,
  secret: string,
): Promise<string | null> {
  if (!agent.encryptedConfig || !agent.encryptionIv || !agent.encryptionTag) {
    return null;
  }

  const config = (await decryptAgentConfigBlob(
    {
      ciphertext: agent.encryptedConfig,
      iv: agent.encryptionIv,
      tag: agent.encryptionTag,
    },
    secret,
  )) as ChannelConfigView | null;
  const botToken = config?.channels?.[channel]?.botToken;

  return typeof botToken === "string" && botToken ? botToken : null;
}

/**
 * The inbound webhook URL shape, which lives in three places by necessity: built
 * here, built for the generated resource file in `packages/broods/src/codegen.ts`,
 * and parsed by `matchWebhookPath` in `apps/core/src/harness/integrations.ts`.
 * Change one, change all three.
 *
 * Production keeps the bare path; every other stage is addressed through its own
 * `endpointId` so two stages of one account never contend for a delivery.
 */
function webhookPath(
  accountId: string,
  endpointId: string,
  channel: string,
  stage: Doc<"stages">,
): string {
  const account = encodeURIComponent(accountId);
  const name = encodeURIComponent(channel);
  if (stage.kind === undefined || stage.kind === "production") {
    return `/webhooks/${account}/${name}`;
  }

  return `/webhooks/${account}/dev/${encodeURIComponent(endpointId)}/${name}`;
}
