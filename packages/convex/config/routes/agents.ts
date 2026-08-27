/**
 * Agent config CRUD (`/v1/agents*`) plus the live channel-directory lookup
 * (`/v1/agents/{id}/channels/{type}/directory`). Owns agent config
 * encrypt/decrypt, env-placeholder resolution, and reference validation.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  collectEnvPlaceholderNames,
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
  substituteAccountEnvPlaceholders,
} from "../../model/agentConfigCodec";
import {
  normalizeCreateAgentInput,
  normalizeUpdateAgentInput,
  toPublicAgentResponse,
  type AgentConfig,
} from "../../model/agentRules";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import { isPlainObject } from "../../model/objects";
import { fetchSlackChannelDirectory } from "../../model/slackDirectory";
import {
  configEncryptionSecret,
  json,
  methodNotAllowed,
  writeAudit,
} from "./shared";

type PreparedAccountAgentConfig = {
  encrypted: { ciphertext: string; iv: string; tag: string };
  source?: { ciphertext: string; iv: string; tag: string };
};

// Skills are account-scoped, so bare names canonicalize to <accountId>/<name>
// in place — callers must run this BEFORE the config is encrypted to persist.
export function canonicalizeAgentSkillPaths(
  accountId: Id<"accounts">,
  config: AgentConfig | undefined,
): void {
  const skills = config?.skills;
  if (!skills?.allowed) return;
  skills.allowed = skills.allowed.map((skillPath) =>
    skillPath.includes("/") ? skillPath : `${accountId}/${skillPath}`,
  );
}

/**
 * Lists the live channel directory (id, name, privacy, bot membership) for an
 * agent's configured messaging channel — Slack only for now. The decrypted
 * stored credential is used server-side and never included in the response, so
 * dashboards can offer a pick-a-channel UX without re-collecting tokens.
 */
export async function handleAgentChannelDirectoryRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  agentId: string,
  channelType: string,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const record: Doc<"agents"> | null = await ctx.runQuery(
    internal.agent.agents.getById,
    {
      accountId: accountId,
      agentId: agentId,
    },
  );
  if (!record) return json({ error: "Agent not found" }, 404);
  if (channelType !== "slack") {
    return json(
      {
        error: `Channel directory is not supported for ${channelType}`,
        reason: "unsupported_channel_type",
      },
      400,
    );
  }
  // The resolved config (env placeholders substituted), not the public-read
  // source config — this is the same view the runtime uses to post messages.
  const config = await decryptAgentConfig(record);
  const channels = isPlainObject(config.channels) ? config.channels : undefined;
  const slack =
    channels && isPlainObject(channels.slack) ? channels.slack : undefined;
  const botToken =
    typeof slack?.botToken === "string" ? slack.botToken.trim() : "";
  if (!botToken) {
    return json(
      {
        error: "config.channels.slack.botToken is not configured",
        reason: "not_configured",
      },
      409,
    );
  }

  const directory = await fetchSlackChannelDirectory(botToken);
  if (!directory.ok) {
    return json(
      { error: directory.error, reason: directory.reason },
      directory.status,
    );
  }

  return json({ channels: directory.channels, truncated: directory.truncated });
}

/**
 * Agent CRUD: list/create on the collection, get/patch/delete by id.
 * Mirrors core's former handleAgentRoute contract.
 */
export async function handleAgentConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  agentId?: string,
): Promise<Response> {
  if (!agentId)
    return await handleAgentCollectionRoute(ctx, req, accountId, actor);

  if (req.method === "GET") {
    const record: Doc<"agents"> | null = await ctx.runQuery(
      internal.agent.agents.getById,
      {
        accountId: accountId,
        agentId: agentId,
      },
    );

    return record
      ? json(
          toPublicAgentResponse(
            record,
            await decryptAgentConfigForPublicRead(record),
          ),
        )
      : json({ error: "Agent not found" }, 404);
  }
  if (req.method === "PATCH") {
    return await patchAgentConfigRoute(ctx, req, accountId, actor, agentId);
  }
  if (req.method === "DELETE") {
    const existing: Doc<"agents"> | null = await ctx.runQuery(
      internal.agent.agents.getById,
      {
        accountId: accountId,
        agentId: agentId,
      },
    );
    if (!existing) return json({ error: "Agent not found" }, 404);
    await ctx.runMutation(internal.agent.agents.remove, {
      accountId: accountId,
      agentId: agentId,
    });
    // The agent row is gone; its conversations, queued work and status rows go
    // with it, in batches that continue on their own.
    await ctx.runMutation(internal.runtime.deleteAgentRuntimeData, {
      accountId: accountId,
      agentId: agentId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "deleted",
      resource: { kind: "agent", id: existing._id, name: existing.name },
      summary: "Agent deleted",
      detailsJson: auditDetailsJson({ agentId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

async function decryptAgentConfig(doc: Doc<"agents">): Promise<AgentConfig> {
  if (!doc.encryptedConfig || !doc.encryptionIv || !doc.encryptionTag) {
    return {};
  }
  const decrypted = await decryptAgentConfigBlob(
    {
      ciphertext: doc.encryptedConfig,
      iv: doc.encryptionIv,
      tag: doc.encryptionTag,
    },
    configEncryptionSecret(),
  );
  if (!decrypted) throw new Error("Failed to decrypt agent config");

  return decrypted as AgentConfig;
}

/** Decrypt the unresolved config when present so API reads and PATCHes preserve placeholders. */
async function decryptAgentConfigForPublicRead(
  doc: Doc<"agents">,
): Promise<AgentConfig> {
  if (
    !doc.encryptedSourceConfig ||
    !doc.sourceEncryptionIv ||
    !doc.sourceEncryptionTag
  ) {
    return await decryptAgentConfig(doc);
  }
  const decrypted = await decryptAgentConfigBlob(
    {
      ciphertext: doc.encryptedSourceConfig,
      iv: doc.sourceEncryptionIv,
      tag: doc.sourceEncryptionTag,
    },
    configEncryptionSecret(),
  );
  if (!decrypted) throw new Error("Failed to decrypt agent source config");

  return decrypted as AgentConfig;
}

async function encryptAgentConfig(
  config: AgentConfig,
): Promise<{ ciphertext: string; iv: string; tag: string }> {
  return await encryptAgentConfigBlob(config, configEncryptionSecret());
}

/** Collection verbs: list agents on GET, create (with name-collision 409) on POST. */
async function handleAgentCollectionRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
): Promise<Response> {
  if (req.method === "GET") {
    const records: Doc<"agents">[] = await ctx.runQuery(
      internal.agent.agents.list,
      { accountId: accountId },
    );
    const agents = await Promise.all(
      records.map(async (record) =>
        toPublicAgentResponse(
          record,
          await decryptAgentConfigForPublicRead(record),
        ),
      ),
    );

    return json({ agents: agents });
  }
  if (req.method === "POST") {
    const input = normalizeCreateAgentInput(await req.json());
    // Names identify agents to config-plane clients (lookup-before-create
    // upserts), so a duplicate must 409 instead of silently forking.
    const duplicate: Doc<"agents"> | null = await ctx.runQuery(
      internal.agent.agents.getByName,
      {
        accountId: accountId,
        name: input.name,
      },
    );
    if (duplicate) {
      return json(
        {
          error: `Agent name already exists: ${input.name}`,
          agentId: duplicate._id,
        },
        409,
      );
    }
    // Before encryption: canonicalization must land in the persisted config.
    canonicalizeAgentSkillPaths(accountId, input.config);
    const config = await prepareAccountAgentConfig(
      ctx,
      accountId,
      input.config,
    );
    await validateAgentReferences(ctx, accountId, input.config);
    const createdId: Id<"agents"> = await ctx.runMutation(
      internal.agent.agents.create,
      {
        accountId: accountId,
        name: input.name,
        description: input.description,
        encryptedConfig: config.encrypted.ciphertext,
        encryptionIv: config.encrypted.iv,
        encryptionTag: config.encrypted.tag,
        ...(config.source
          ? {
              encryptedSourceConfig: config.source.ciphertext,
              sourceEncryptionIv: config.source.iv,
              sourceEncryptionTag: config.source.tag,
            }
          : {}),
      },
    );
    const created: Doc<"agents"> | null = await ctx.runQuery(
      internal.agent.agents.getById,
      {
        accountId: accountId,
        agentId: createdId,
      },
    );
    if (!created) throw new Error("Failed to fetch created agent");
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "created",
      resource: { kind: "agent", id: created._id, name: created.name },
      summary: "Agent created",
      detailsJson: auditDetailsJson({ agentId: created._id }),
    });

    return json(
      {
        accountId: created.accountId,
        agentId: created._id,
        name: created.name,
        ...(created.description ? { description: created.description } : {}),
      },
      201,
    );
  }

  return methodNotAllowed(["GET", "POST"]);
}

/** PATCH one agent: merge config, re-encrypt, and persist with a 409 on name collision. */
async function patchAgentConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  agentId: string,
): Promise<Response> {
  const existing: Doc<"agents"> | null = await ctx.runQuery(
    internal.agent.agents.getById,
    {
      accountId: accountId,
      agentId: agentId,
    },
  );
  if (!existing) return json({ error: "Agent not found" }, 404);
  const existingConfig = await decryptAgentConfigForPublicRead(existing);
  const patch = normalizeUpdateAgentInput(existingConfig, await req.json());
  if (patch.name !== undefined && patch.name !== existing.name) {
    const collision: Doc<"agents"> | null = await ctx.runQuery(
      internal.agent.agents.getByName,
      {
        accountId: accountId,
        name: patch.name,
      },
    );
    if (collision) {
      return json(
        {
          error: `Agent name already exists: ${patch.name}`,
          agentId: collision._id,
        },
        409,
      );
    }
  }
  // Before encryption: canonicalization must land in the persisted config.
  canonicalizeAgentSkillPaths(accountId, patch.config);
  const config = await prepareAccountAgentConfig(ctx, accountId, patch.config);
  await validateAgentReferences(ctx, accountId, patch.config);
  await ctx.runMutation(internal.agent.agents.update, {
    accountId: accountId,
    agentId: agentId,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    // Null is dropped, not forwarded: core's adapter has always done
    // `?? undefined` here, so PATCH {description: null} is a no-op
    // for agents (unlike policies, where null clears).
    ...(patch.description !== undefined
      ? { description: patch.description ?? undefined }
      : {}),
    encryptedConfig: config.encrypted.ciphertext,
    encryptionIv: config.encrypted.iv,
    encryptionTag: config.encrypted.tag,
    ...(config.source
      ? {
          encryptedSourceConfig: config.source.ciphertext,
          sourceEncryptionIv: config.source.iv,
          sourceEncryptionTag: config.source.tag,
        }
      : { clearSourceConfig: true }),
  });
  const updated: Doc<"agents"> | null = await ctx.runQuery(
    internal.agent.agents.getById,
    {
      accountId: accountId,
      agentId: agentId,
    },
  );
  if (updated) {
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "updated",
      resource: { kind: "agent", id: updated._id, name: updated.name },
      summary: "Agent updated",
      detailsJson: auditDetailsJson({ agentId: updated._id }),
    });
  }

  return updated
    ? json(
        toPublicAgentResponse(
          updated,
          await decryptAgentConfigForPublicRead(updated),
        ),
      )
    : json({ error: "Agent not found" }, 404);
}

/** Resolve valid account env references on a normalized config, rejecting missing names on writes. */
async function prepareAccountAgentConfig(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  sourceConfig: AgentConfig,
): Promise<PreparedAccountAgentConfig> {
  const names = [...collectEnvPlaceholderNames(sourceConfig)].sort();
  if (names.length === 0)
    return { encrypted: await encryptAgentConfig(sourceConfig) };
  const values: Record<string, string> = await ctx.runQuery(
    internal.account.envVars.loadValues,
    { accountId: accountId },
  );
  const missing = names.filter(
    (name) => !Object.prototype.hasOwnProperty.call(values, name),
  );
  if (missing.length > 0)
    throw new Error(`unknown env vars: ${missing.join(", ")}`);

  return {
    encrypted: await encryptAgentConfig(
      substituteAccountEnvPlaceholders(sourceConfig, values),
    ),
    source: await encryptAgentConfig(sourceConfig),
  };
}

async function validateAgentPolicyIds(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  config: AgentConfig,
): Promise<void> {
  for (const policyId of config.policies ?? []) {
    const policy: Doc<"agentPolicies"> | null = await ctx.runQuery(
      internal.agent.policies.getById,
      {
        accountId: accountId,
        policyId: policyId,
      },
    );
    if (!policy) throw new Error(`Agent policy not found: ${policyId}`);
  }
}

async function validateAgentReferences(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  config: AgentConfig,
): Promise<void> {
  await validateAgentSkillPaths(ctx, accountId, config);
  await validateAgentSubagentIds(ctx, accountId, config);
  await validateAgentPolicyIds(ctx, accountId, config);
}

async function validateAgentSkillPaths(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  config: AgentConfig,
): Promise<void> {
  for (const skillPath of config.skills?.allowed ?? []) {
    const parts = skillPath.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid skill path: ${skillPath}`);
    }
    if (parts[0] !== accountId) {
      throw new Error(`Skill path belongs to another account: ${skillPath}`);
    }
    const skill: unknown | null = await ctx.runAction(internal.aws.skills.get, {
      accountId: accountId,
      skillName: parts[1],
    });
    if (!skill) throw new Error(`Skill not found: ${skillPath}`);
  }
}

async function validateAgentSubagentIds(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  config: AgentConfig,
): Promise<void> {
  for (const agentId of config.subagent?.allowed ?? []) {
    const agent: Doc<"agents"> | null = await ctx.runQuery(
      internal.agent.agents.getById,
      {
        accountId: accountId,
        agentId: agentId,
      },
    );
    if (!agent) throw new Error(`Subagent not found: ${agentId}`);
  }
}
