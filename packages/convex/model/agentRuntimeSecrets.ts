/**
 * Encrypted runtime-variable storage for agent configs.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
    decryptAgentConfigBlob,
    encryptAgentConfigBlob,
    type EncryptedAgentConfig,
} from "./agentConfigCodec";

export type RuntimeVariable = { key: string; value: string };

const MASKED_RUNTIME_VARIABLE_VALUE = "";

function publicRuntimeVariables(entries: RuntimeVariable[]): RuntimeVariable[] {
    return entries.map((entry) => ({
        key: entry.key,
        value: MASKED_RUNTIME_VARIABLE_VALUE,
    }));
}

function runtimeSecret(): string {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) {
        throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to store runtime variables");
    }

    return secret;
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

    const decrypted = await decryptAgentConfigBlob(
        {
            ciphertext: stored.ciphertext,
            iv: stored.iv,
            tag: stored.tag,
        } satisfies EncryptedAgentConfig,
        runtimeSecret(),
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
            entry.value === MASKED_RUNTIME_VARIABLE_VALUE && Object.prototype.hasOwnProperty.call(previous, entry.key)
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

    const encrypted = await encryptAgentConfigBlob(variables, runtimeSecret());
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
