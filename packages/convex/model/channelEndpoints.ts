// Single writer of the `channelEndpoints` projection the forwarders subscribe to. Every seam
// that changes channels, deployments or stages refreshes it; `endpointReconcile.ts` heals misses.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { accountCipherForWrite, hasEncryptionSecret } from "./accountKeys";
import type { AccountCipher } from "./envelope";
import { agentsInStage } from "./projectScope";

type ChannelCredentials = Pick<DesiredEndpoint, "apiUrl" | "botToken">;

interface ChannelsConfigView {
  channels?: Record<
    string,
    { apiUrl?: unknown; botToken?: unknown } | undefined
  >;
}

interface DesiredEndpoint {
  agentId: string;
  agentName: string;
  apiUrl?: string;
  botToken: string;
  endpointId: string;
  platform: string;
  webhookPath: string;
}

export async function channelEndpointBotToken(
  row: Doc<"channelEndpoints">,
  cipher: AccountCipher,
): Promise<string | null> {
  const decrypted = await cipher.decrypt("channelEndpoints:tokenCiphertext", {
    ciphertext: row.tokenCiphertext,
    iv: row.tokenIv,
    tag: row.tokenTag,
  });
  const botToken = decrypted?.botToken;

  return typeof botToken === "string" && botToken ? botToken : null;
}

export async function refreshAccountChannelEndpoints(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<void> {
  if (!hasEncryptionSecret()) return;

  const cipher = await accountCipherForWrite(ctx, accountId);
  const desired = await desiredEndpoints(ctx, accountId, cipher);
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
    // Re-encrypting mints a fresh IV, so rewriting an unchanged row would wake every forwarder.
    if (current?.digest === digest) continue;
    const encrypted = await cipher.encrypt("channelEndpoints:tokenCiphertext", {
      botToken: entry.botToken,
    });
    const fields = {
      accountId: accountId,
      agentId: entry.agentId,
      agentName: entry.agentName,
      apiUrl: entry.apiUrl,
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

// Also built in `packages/broods/src/codegen.ts` and parsed by `matchWebhookPath` in
// `apps/core/src/harness/integrations.ts`: change all three together.
export function webhookPath(
  accountId: string,
  endpointId: string,
  channel: string,
  stage: Doc<"stages">,
): string {
  const account = encodeURIComponent(accountId);
  const name = encodeURIComponent(channel);
  if (stage.kind === "production") {
    return `/v1/webhooks/${account}/${name}`;
  }

  return `/v1/webhooks/${account}/dev/${encodeURIComponent(endpointId)}/${name}`;
}

async function agentChannelCredentials(
  agent: Doc<"agents">,
  cipher: AccountCipher,
): Promise<Map<string, ChannelCredentials>> {
  const credentials = new Map<string, ChannelCredentials>();
  if (!agent.encryptedConfig || !agent.encryptionIv || !agent.encryptionTag) {
    return credentials;
  }

  const config = (await cipher.decrypt("agents:encryptedConfig", {
    ciphertext: agent.encryptedConfig,
    iv: agent.encryptionIv,
    tag: agent.encryptionTag,
  })) as ChannelsConfigView | null;
  for (const [platform, channel] of Object.entries(config?.channels ?? {})) {
    const botToken = channel?.botToken;
    if (typeof botToken !== "string" || !botToken) continue;
    const apiUrl = channel?.apiUrl;
    credentials.set(platform, {
      apiUrl: typeof apiUrl === "string" && apiUrl ? apiUrl : undefined,
      botToken: botToken,
    });
  }

  return credentials;
}

async function desiredEndpoints(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  cipher: AccountCipher,
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
      const credentials = await agentChannelCredentials(agent, cipher);
      for (const [platform, { apiUrl, botToken }] of credentials) {
        const entry: DesiredEndpoint = {
          agentId: agent._id,
          agentName: agent.name,
          apiUrl: apiUrl,
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

async function endpointDigest(entry: DesiredEndpoint): Promise<string> {
  const value = JSON.stringify([
    entry.agentId,
    entry.agentName,
    entry.apiUrl ?? null,
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
