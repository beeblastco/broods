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
  substituteAccountEnvPlaceholders,
} from "../../model/agentConfigCodec";
import type { AccountCipher, EncryptedBlob } from "../../model/envelope";
import {
  normalizeCreateAgentInput,
  normalizeUpdateAgentInput,
  type AgentConfig,
} from "../../model/agentRules";
import { auditDetailsJson, type AuditActor } from "../../model/auditEvents";
import { isPlainObject } from "../../model/objects";
import { toPublicAgentResponse } from "../../model/responses";
import { fetchSlackChannelDirectory } from "../../model/slackDirectory";
import type { RolePrincipal } from "../../model/apiAuthorization";
import type { StageScopedRef } from "../../model/projectScope";
import {
  accountCipherForAction,
  assertRefsInPin,
  json,
  jsonError,
  methodNotAllowed,
  collectionPage,
  writeAudit,
} from "./shared";
import { ClientError } from "../../model/clientError";

type PreparedAccountAgentConfig = {
  encrypted: EncryptedBlob;
  source?: EncryptedBlob;
};

// Skills are account-scoped, so bare names canonicalize to <accountId>/<name>
// in place. Callers must run this BEFORE the config is encrypted to persist.
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
 * agent's configured messaging channel, Slack only for now. The decrypted
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
  if (!record) return jsonError(404, "Agent not found");
  if (channelType !== "slack") {
    return jsonError(
      400,
      `Channel directory is not supported for ${channelType}`,
      { code: "unsupported_channel_type", param: "channelType" },
    );
  }
  // The resolved config (env placeholders substituted), not the public-read
  // source config. This is the same view the runtime uses to post messages.
  const config = await decryptAgentConfig(
    await accountCipherForAction(ctx, accountId, "read"),
    record,
  );
  const channels = isPlainObject(config.channels) ? config.channels : undefined;
  const slack =
    channels && isPlainObject(channels.slack) ? channels.slack : undefined;
  const botToken =
    typeof slack?.botToken === "string" ? slack.botToken.trim() : "";
  if (!botToken) {
    return jsonError(409, "config.channels.slack.botToken is not configured", {
      code: "not_configured",
      param: "config.channels.slack.botToken",
    });
  }

  const directory = await fetchSlackChannelDirectory(botToken);
  if (!directory.ok) {
    return jsonError(
      directory.status,
      directory.error,
      { code: directory.reason },
      directory.retryAfterSeconds === undefined
        ? {}
        : { "Retry-After": String(directory.retryAfterSeconds) },
    );
  }

  return json({ channels: directory.channels, truncated: directory.truncated });
}

/** Mirrors core's former handleAgentRoute contract. */
export async function handleAgentConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: AuditActor,
  agentId: string | undefined,
  role: RolePrincipal | undefined,
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
            await decryptAgentConfigForPublicRead(
              await accountCipherForAction(ctx, accountId, "read"),
              record,
            ),
          ),
        )
      : jsonError(404, "Agent not found");
  }
  if (req.method === "PATCH") {
    return await patchAgentConfigRoute(
      ctx,
      req,
      accountId,
      actor,
      agentId,
      role,
    );
  }
  if (req.method === "DELETE") {
    const existing: Doc<"agents"> | null = await ctx.runQuery(
      internal.agent.agents.getById,
      {
        accountId: accountId,
        agentId: agentId,
      },
    );
    if (!existing) return jsonError(404, "Agent not found");
    // Takes its crons, conversations, queued work and status rows with it.
    await ctx.runMutation(internal.agent.agents.remove, {
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

async function decryptAgentConfig(
  cipher: AccountCipher,
  doc: Doc<"agents">,
): Promise<AgentConfig> {
  if (!doc.encryptedConfig || !doc.encryptionIv || !doc.encryptionTag) {
    return {};
  }
  const decrypted = await cipher.decrypt("agents:encryptedConfig", {
    ciphertext: doc.encryptedConfig,
    iv: doc.encryptionIv,
    tag: doc.encryptionTag,
  });
  if (!decrypted) throw new Error("Failed to decrypt agent config");

  return decrypted as AgentConfig;
}

/** Decrypt the unresolved config when present so API reads and PATCHes preserve placeholders. */
async function decryptAgentConfigForPublicRead(
  cipher: AccountCipher,
  doc: Doc<"agents">,
): Promise<AgentConfig> {
  if (
    !doc.encryptedSourceConfig ||
    !doc.sourceEncryptionIv ||
    !doc.sourceEncryptionTag
  ) {
    return await decryptAgentConfig(cipher, doc);
  }
  const decrypted = await cipher.decrypt("agents:encryptedSourceConfig", {
    ciphertext: doc.encryptedSourceConfig,
    iv: doc.sourceEncryptionIv,
    tag: doc.sourceEncryptionTag,
  });
  if (!decrypted) throw new Error("Failed to decrypt agent source config");

  return decrypted as AgentConfig;
}

async function handleAgentCollectionRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: AuditActor,
): Promise<Response> {
  if (req.method === "GET") {
    const cipher = await accountCipherForAction(ctx, accountId, "read");

    return collectionPage("agents", req, {
      all: () =>
        ctx.runQuery(internal.agent.agents.list, { accountId: accountId }),
      item: async (record) =>
        toPublicAgentResponse(
          record,
          await decryptAgentConfigForPublicRead(cipher, record),
        ),
      page: (options) =>
        ctx.runQuery(internal.agent.agents.listPage, {
          accountId: accountId,
          paginationOpts: options,
        }),
    });
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
      return jsonError(
        409,
        `Agent name already exists: ${input.name} (${duplicate._id})`,
        { code: "agent_name_exists", param: "name" },
      );
    }
    // Before encryption: canonicalization must land in the persisted config.
    canonicalizeAgentSkillPaths(accountId, input.config);
    const config = await prepareAccountAgentConfig(
      ctx,
      await accountCipherForAction(ctx, accountId, "write"),
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

async function patchAgentConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: AuditActor,
  agentId: string,
  role: RolePrincipal | undefined,
): Promise<Response> {
  const existing: Doc<"agents"> | null = await ctx.runQuery(
    internal.agent.agents.getById,
    {
      accountId: accountId,
      agentId: agentId,
    },
  );
  if (!existing) return jsonError(404, "Agent not found");
  const cipher = await accountCipherForAction(ctx, accountId, "write");
  const existingConfig = await decryptAgentConfigForPublicRead(
    cipher,
    existing,
  );
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
      return jsonError(
        409,
        `Agent name already exists: ${patch.name} (${collision._id})`,
        { code: "agent_name_exists", param: "name" },
      );
    }
  }
  // Before encryption: canonicalization must land in the persisted config.
  canonicalizeAgentSkillPaths(accountId, patch.config);
  const config = await prepareAccountAgentConfig(
    ctx,
    cipher,
    accountId,
    patch.config,
  );
  await validateAgentReferences(ctx, accountId, patch.config);
  await assertRefsInPin(ctx, accountId, role, agentConfigRefs(patch.config));
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
          await decryptAgentConfigForPublicRead(cipher, updated),
        ),
      )
    : jsonError(404, "Agent not found");
}

async function prepareAccountAgentConfig(
  ctx: ActionCtx,
  cipher: AccountCipher,
  accountId: Id<"accounts">,
  sourceConfig: AgentConfig,
): Promise<PreparedAccountAgentConfig> {
  const names = [...collectEnvPlaceholderNames(sourceConfig)].sort();
  if (names.length === 0)
    return {
      encrypted: await cipher.encrypt("agents:encryptedConfig", sourceConfig),
    };
  const values: Record<string, string> = await ctx.runQuery(
    internal.account.envVars.loadValues,
    { accountId: accountId },
  );
  const missing = names.filter(
    (name) => !Object.prototype.hasOwnProperty.call(values, name),
  );
  if (missing.length > 0)
    throw new ClientError(`unknown env vars: ${missing.join(", ")}`);

  return {
    encrypted: await cipher.encrypt(
      "agents:encryptedConfig",
      substituteAccountEnvPlaceholders(sourceConfig, values),
    ),
    source: await cipher.encrypt("agents:encryptedSourceConfig", sourceConfig),
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
    if (!policy)
      throw new ClientError(`Agent policy not found: ${policyId}`, "not_found");
  }
}

/** The stage-scoped resources an agent config names. */
function agentConfigRefs(config: AgentConfig | undefined): StageScopedRef[] {
  return [
    ...(config?.sandboxes ?? []).map((id) => ({
      type: "sandboxes" as const,
      id: id,
    })),
    ...(config?.workspaces ?? []).map((workspace) => ({
      type: "workspaces" as const,
      id: workspace.workspaceId,
    })),
    ...(config?.policies ?? []).map((id) => ({
      type: "policies" as const,
      id: id,
    })),
    ...(config?.subagent?.allowed ?? []).map((id) => ({
      type: "agents" as const,
      id: id,
    })),
    ...Object.keys(config?.mcp ?? {}).map((id) => ({
      type: "mcp" as const,
      id: id,
    })),
  ];
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
      throw new ClientError(`Invalid skill path: ${skillPath}`);
    }
    if (parts[0] !== accountId) {
      throw new ClientError(
        `Skill path belongs to another account: ${skillPath}`,
        "unauthorized",
      );
    }
    const skill = await ctx.runAction(internal.aws.skills.get, {
      accountId: accountId,
      skillName: parts[1],
    });
    if (!skill)
      throw new ClientError(`Skill not found: ${skillPath}`, "not_found");
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
    if (!agent)
      throw new ClientError(`Subagent not found: ${agentId}`, "not_found");
  }
}
