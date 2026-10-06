/**
 * Encrypted runtime-variable storage for agent configs.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  accountCipher,
  accountCipherForWrite,
  requireAccountIdForProject,
} from "./accountKeys";
import { stableJson } from "./objects";

const MASKED_RUNTIME_VARIABLE_VALUE = "";

export type RuntimeVariable = { key: string; value: string };

/**
 * Deletes an agent config with its runtime secrets. The secrets are keyed to
 * the config, so every path that removes an `agentConfigs` row goes through
 * here or they orphan, undecryptable, behind it.
 */
export async function deleteAgentConfig(
  ctx: MutationCtx,
  configId: Id<"agentConfigs">,
): Promise<void> {
  const secrets = await ctx.db
    .query("agentRuntimeSecrets")
    .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", configId))
    .collect();
  for (const secret of secrets) await ctx.db.delete(secret._id);
  await ctx.db.delete(configId);
}

export async function loadAgentRuntimeSecrets(
  ctx: QueryCtx | MutationCtx,
  configId: Id<"agentConfigs">,
): Promise<Record<string, string>> {
  const stored = await ctx.db
    .query("agentRuntimeSecrets")
    .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", configId))
    .unique();
  if (!stored) {
    return {};
  }

  const cipher = await accountCipher(
    ctx,
    await accountIdForConfig(ctx, configId),
  );
  const decrypted = await cipher.decrypt(
    "agentRuntimeSecrets:ciphertext",
    stored,
  );
  if (!decrypted) {
    throw new Error("Failed to decrypt runtime variables");
  }

  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(decrypted)) {
    if (typeof value === "string") variables[key] = value;
  }

  return variables;
}

export async function saveAgentRuntimeSecrets(
  ctx: MutationCtx,
  configId: Id<"agentConfigs">,
  next: RuntimeVariable[],
): Promise<RuntimeVariable[]> {
  const previous = await loadAgentRuntimeSecrets(ctx, configId);
  const variables: Record<string, string> = {};
  for (const entry of next) {
    variables[entry.key] =
      entry.value === MASKED_RUNTIME_VARIABLE_VALUE &&
      Object.prototype.hasOwnProperty.call(previous, entry.key)
        ? previous[entry.key]
        : entry.value;
  }

  const stored = await ctx.db
    .query("agentRuntimeSecrets")
    .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", configId))
    .unique();

  if (Object.keys(variables).length === 0) {
    if (stored) await ctx.db.delete(stored._id);

    return [];
  }

  // A fresh IV would rewrite the row on every deploy even when nothing changed.
  if (stored && stableJson(previous) === stableJson(variables)) {
    return publicRuntimeVariables(next);
  }
  const cipher = await accountCipherForWrite(
    ctx,
    await accountIdForConfig(ctx, configId),
  );
  const encrypted = await cipher.encrypt(
    "agentRuntimeSecrets:ciphertext",
    variables,
  );
  const now = Date.now();
  if (stored) {
    await ctx.db.patch(stored._id, {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("agentRuntimeSecrets", {
      agentConfigId: configId,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      updatedAt: now,
    });
  }

  return publicRuntimeVariables(next);
}

function publicRuntimeVariables(entries: RuntimeVariable[]): RuntimeVariable[] {
  return entries.map((entry) => ({
    key: entry.key,
    value: MASKED_RUNTIME_VARIABLE_VALUE,
  }));
}

/** Runtime secrets hang off a config row, which reaches its account through the project. */
async function accountIdForConfig(
  ctx: QueryCtx | MutationCtx,
  configId: Id<"agentConfigs">,
): Promise<Id<"accounts">> {
  const config = await ctx.db.get(configId);
  if (!config) throw new Error("Agent config not found");

  return await requireAccountIdForProject(ctx, config.projectId);
}
