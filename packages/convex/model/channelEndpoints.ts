/**
 * Single writer for the `channelEndpoints` projection: one small row per
 * (agent, channel, deployment) that configures a bot token, so the forwarder's
 * standing `listConnections` subscription reads a few rows keyed by platform
 * instead of every deployment plus every agent's encrypted config blob.
 *
 * Every seam that changes an agent's channels, its deployment, or its stage
 * calls `refreshAccountChannelEndpoints`; the hourly reconcile in
 * `channelConnections.ts` sweeps every account so a missed seam self-heals
 * instead of leaving a bot silently connected or absent.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
} from "./agentConfigCodec";
import { agentsInStage } from "./projectScope";

/** The slice of a decrypted agent config the projection reads. */
interface ChannelsConfigView {
  channels?: Record<string, { botToken?: unknown } | undefined>;
}

interface DesiredEndpoint {
  agentId: string;
  agentName: string;
  botToken: string;
  endpointId: string;
  platform: string;
  webhookPath: string;
}

/** The decrypted bot token carried by one projection row. */
export async function channelEndpointBotToken(
  row: Doc<"channelEndpoints">,
  secret: string,
): Promise<string | null> {
  const decrypted = (await decryptAgentConfigBlob(
    {
      ciphertext: row.tokenCiphertext,
      iv: row.tokenIv,
      tag: row.tokenTag,
    },
    secret,
  )) as { botToken?: unknown } | null;
  const botToken = decrypted?.botToken;

  return typeof botToken === "string" && botToken ? botToken : null;
}

/**
 * Recomputes every projection row for one account from the source tables and
 * diffs it against what is stored: unchanged rows are left untouched (a digest
 * comparison, because re-encrypting a token mints a fresh IV and would dirty
 * the row — and the forwarder's subscription — on every refresh), changed rows
 * are replaced, and rows no longer derivable are deleted. Safe to call from
 * any mutation seam; a refresh that derives nothing clears the account.
 */
export async function refreshAccountChannelEndpoints(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<void> {
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) return;

  const desired = await desiredEndpoints(ctx, accountId, secret);
  const existing = await ctx.db
    .query("channelEndpoints")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .collect();
  const existingByKey = new Map(
    existing.map((row) => [endpointKey(row), row] as const),
  );

  for (const entry of desired.values()) {
    const digest = await endpointDigest(entry);
    const current = existingByKey.get(endpointKey(entry));
    existingByKey.delete(endpointKey(entry));
    if (current?.digest === digest) continue;
    const encrypted = await encryptAgentConfigBlob(
      { botToken: entry.botToken },
      secret,
    );
    const fields = {
      accountId: accountId,
      agentId: entry.agentId,
      agentName: entry.agentName,
      digest: digest,
      endpointId: entry.endpointId,
      platform: entry.platform,
      tokenCiphertext: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenTag: encrypted.tag,
      updatedAt: Date.now(),
      webhookPath: entry.webhookPath,
    };
    if (current) {
      await ctx.db.patch(current._id, fields);
    } else {
      await ctx.db.insert("channelEndpoints", fields);
    }
  }
  for (const stale of existingByKey.values()) {
    await ctx.db.delete(stale._id);
  }
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
export function webhookPath(
  accountId: string,
  endpointId: string,
  channel: string,
  stage: Doc<"stages">,
): string {
  const account = encodeURIComponent(accountId);
  const name = encodeURIComponent(channel);
  if (stage.kind === "production") {
    return `/webhooks/${account}/${name}`;
  }

  return `/webhooks/${account}/dev/${encodeURIComponent(endpointId)}/${name}`;
}

/** Every (agent, channel, deployment) row this account should project. */
async function desiredEndpoints(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  secret: string,
): Promise<Map<string, DesiredEndpoint>> {
  const deployments = await ctx.db
    .query("agentDeployments")
    .withIndex("by_accountId_and_status", (q) =>
      q.eq("accountId", accountId).eq("status", "active"),
    )
    .collect();
  const desired = new Map<string, DesiredEndpoint>();

  for (const deployment of deployments) {
    const stage = await ctx.db.get(deployment.stageId);
    if (!stage) continue;
    const agents = await agentsInStage(
      ctx,
      { projectId: deployment.projectId, stageId: deployment.stageId },
      accountId,
    );
    for (const agent of agents) {
      for (const [platform, botToken] of await agentBotTokens(agent, secret)) {
        const entry: DesiredEndpoint = {
          agentId: agent._id,
          agentName: agent.name,
          botToken: botToken,
          endpointId: deployment.endpointId,
          platform: platform,
          webhookPath: webhookPath(
            accountId,
            deployment.endpointId,
            platform,
            stage,
          ),
        };
        desired.set(endpointKey(entry), entry);
      }
    }
  }

  return desired;
}

/** Every configured (channel, botToken) pair in one agent's decrypted config. */
async function agentBotTokens(
  agent: Doc<"agents">,
  secret: string,
): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  if (!agent.encryptedConfig || !agent.encryptionIv || !agent.encryptionTag) {
    return tokens;
  }

  const config = (await decryptAgentConfigBlob(
    {
      ciphertext: agent.encryptedConfig,
      iv: agent.encryptionIv,
      tag: agent.encryptionTag,
    },
    secret,
  )) as ChannelsConfigView | null;
  for (const [platform, channel] of Object.entries(config?.channels ?? {})) {
    const botToken = channel?.botToken;
    if (typeof botToken === "string" && botToken) {
      tokens.set(platform, botToken);
    }
  }

  return tokens;
}

/** Stable content digest so an unchanged row is never rewritten. */
async function endpointDigest(entry: DesiredEndpoint): Promise<string> {
  const value = JSON.stringify([
    entry.agentId,
    entry.agentName,
    entry.botToken,
    entry.endpointId,
    entry.platform,
    entry.webhookPath,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((byte): string => byte.toString(16).padStart(2, "0"))
    .join("");
}

function endpointKey(entry: {
  agentId: string;
  endpointId: string;
  platform: string;
}): string {
  return `${entry.agentId}\u0000${entry.platform}\u0000${entry.endpointId}`;
}
