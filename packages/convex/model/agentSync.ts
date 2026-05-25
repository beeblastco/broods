/**
 * Keeps the filthy-panty `agents` row in sync with cherry-coke's `agentConfigs`.
 *
 * Filthy-panty's harness queries `agents` (not `agentConfigs`) when invoking
 * an agent. Cherry-coke owns the canvas-side `agentConfigs` row; this helper
 * provisions the matching `agents` row in the same Convex transaction and
 * records its `_id` back on `agentConfigs.agentId` so the side panel's
 * "Agent ID" row surfaces a value filthy-panty actually accepts.
 *
 * NOTE: the encrypted `AgentConfig` blob (model/provider/workspace/tools)
 * is intentionally NOT written here yet. Encryption requires
 * ACCOUNT_CONFIG_ENCRYPTION_SECRET to be the same value as filthy-panty's
 * SST secret, and we ship the model-config sync in a follow-up. For now,
 * filthy-panty sees an empty config and any invoke that needs a real model
 * will fail with "config.model.provider is required" — a clear signal that
 * the config sync is the remaining gap.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { encryptAgentConfigBlob, substituteEnvPlaceholders, toNestedAgentConfig } from "./agentConfigCodec";
import { getActiveOrgForUser } from "./ownership/org";

/**
 * Returns the filthy-panty account that owns the caller's active org, or
 * null if the user has no active org or the org is not yet provisioned.
 */
export async function resolveActiveAccountForAuthId(
    ctx: MutationCtx,
    authId: string,
): Promise<Doc<"accounts"> | null> {
    const user = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", authId))
        .unique();
    if (!user) return null;

    const org = await getActiveOrgForUser(ctx, user._id);
    if (!org) return null;

    const account = await ctx.db
        .query("accounts")
        .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
        .unique();

    return account ?? null;
}

/**
 * Ensures `agentConfigs[configId].agentId` references a live `agents` row
 * scoped to the caller's active org. Idempotent: if `agentId` is already
 * set and the referenced row exists, this returns it unchanged.
 */
export async function ensureAgentsRowForConfig(
    ctx: MutationCtx,
    configId: Id<"agentConfigs">,
    authId: string,
): Promise<Id<"agents"> | null> {
    const config = await ctx.db.get(configId);
    if (!config || config.authId !== authId) return null;

    if (config.agentId) {
        const normalized = ctx.db.normalizeId("agents", config.agentId);
        if (normalized) {
            const existing = await ctx.db.get(normalized);
            if (existing) return existing._id;
        }
    }

    const account = await resolveActiveAccountForAuthId(ctx, authId);
    if (!account) return null;

    const now = Date.now();
    const agentId = await ctx.db.insert("agents", {
        accountId: account._id,
        name: config.name,
        description: config.description,
        createdAt: now,
        updatedAt: now,
    });

    await ctx.db.patch(configId, { agentId: agentId, updatedAt: now });

    return agentId;
}

/**
 * Builds the nested filthy-panty `AgentConfig` from the flat row, substitutes
 * `${ENV}` placeholders from `runtimeVariables`, encrypts with the shared
 * AES-256-GCM secret, and writes the result onto the linked `agents` row.
 *
 * Silently no-ops in two cases that are not error conditions:
 *   1. `ACCOUNT_CONFIG_ENCRYPTION_SECRET` is not set in the Convex env
 *      (encryption layer not yet provisioned for this deployment).
 *   2. The `agentConfigs` row has no linked `agentId`
 *      (`ensureAgentsRowForConfig` hasn't run yet, e.g. because the org is
 *      not provisioned with a filthy-panty account).
 */
export async function pushEncryptedConfigToAgentRow(
    ctx: MutationCtx,
    configId: Id<"agentConfigs">,
): Promise<void> {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) return;

    const config = await ctx.db.get(configId);
    if (!config?.agentId) return;
    const normalized = ctx.db.normalizeId("agents", config.agentId);
    if (!normalized) return;
    const agent = await ctx.db.get(normalized);
    if (!agent) return;

    const variables: Record<string, string> = {};
    for (const entry of config.runtimeVariables ?? []) {
        variables[entry.key] = entry.value;
    }

    const nested = toNestedAgentConfig({
        name: config.name,
        description: config.description,
        provider: config.provider,
        modelId: config.modelId,
        systemPrompt: config.systemPrompt,
        maxTurns: config.maxTurns,
        outputFormat: config.outputFormat as Record<string, unknown> | undefined,
        providerOptions: config.providerOptions as Record<string, unknown> | undefined,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        memoryToolEnabled: config.memoryToolEnabled,
        searchToolEnabled: config.searchToolEnabled,
        searchToolConfig: config.searchToolConfig as Record<string, unknown> | undefined,
        extraConfig: config.extraConfig as Record<string, unknown> | undefined,
    });
    const resolved = substituteEnvPlaceholders(nested, variables);
    const encrypted = await encryptAgentConfigBlob(resolved, secret);

    await ctx.db.patch(normalized, {
        encryptedConfig: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        updatedAt: Date.now(),
    });
}

/**
 * Mirrors name/description edits from `agentConfigs` onto the linked
 * `agents` row when one exists. Silently no-ops if the row is missing —
 * the next `ensureAgentsRowForConfig` call will provision it.
 */
export async function syncAgentRowFields(
    ctx: MutationCtx,
    configId: Id<"agentConfigs">,
    patch: { name?: string; description?: string },
): Promise<void> {
    if (patch.name === undefined && patch.description === undefined) return;
    const config = await ctx.db.get(configId);
    if (!config?.agentId) return;
    const normalized = ctx.db.normalizeId("agents", config.agentId);
    if (!normalized) return;
    const agent = await ctx.db.get(normalized);
    if (!agent) return;

    await ctx.db.patch(normalized, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        updatedAt: Date.now(),
    });
}
