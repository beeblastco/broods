/**
 * Re-resolves CLI-synced sandbox configs when an environment variable changes,
 * mirroring `refreshAgentConfigsForEnvironmentVariable`. Sandbox configs bake
 * resolved env values into `encryptedConfig` (core reads it verbatim), so a
 * value change would otherwise stay stale until the next CLI sync. The
 * placeholder source lives in `encryptedSourceConfig`; we re-substitute it with
 * the environment's current values and re-push `encryptedConfig`.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
    decryptAgentConfigBlob,
    encryptAgentConfigBlob,
    substituteEnvPlaceholders,
} from "./agentConfigCodec";
import { loadEnvironmentVariableValues } from "./environmentValues";

/**
 * For every sandbox config in the environment that references `name`, decrypt
 * its placeholder source, re-resolve against the environment's current values,
 * and re-encrypt `encryptedConfig`. No-ops on rows without a stored source
 * (legacy rows synced before placeholder retention) or when the encryption
 * secret is absent.
 * @param value the variable's new value, or `undefined` when it was removed
 */
export async function refreshSandboxConfigsForEnvironmentVariable(
    ctx: MutationCtx,
    projectId: Id<"projects">,
    environmentId: Id<"environments">,
    name: string,
    value: string | undefined,
): Promise<void> {
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) return;

    const configs = await ctx.db
        .query("sandboxConfigs")
        .withIndex("by_environmentId_and_name", (q) => q.eq("environmentId", environmentId))
        .collect();
    const referencing = configs.filter((config) =>
        config.runtimeVariables?.some((entry) => entry.key === name),
    );
    if (referencing.length === 0) return;

    // Read the full value map once: a sandbox may reference several vars, and a
    // partial substitution would leave the others as literal `${OTHER}`.
    const values = await loadEnvironmentVariableValues(ctx, projectId, environmentId);
    if (value === undefined) delete values[name];

    for (const config of referencing) {
        if (!config.encryptedSourceConfig || !config.sourceEncryptionIv || !config.sourceEncryptionTag) {
            continue;
        }
        const source = await decryptAgentConfigBlob(
            {
                ciphertext: config.encryptedSourceConfig,
                iv: config.sourceEncryptionIv,
                tag: config.sourceEncryptionTag,
            },
            secret,
        );
        if (!source) continue;

        const resolved = substituteEnvPlaceholders(source, values);
        const encrypted = await encryptAgentConfigBlob(resolved, secret);
        await ctx.db.patch(config._id, {
            encryptedConfig: encrypted.ciphertext,
            encryptionIv: encrypted.iv,
            encryptionTag: encrypted.tag,
            updatedAt: Date.now(),
        });
    }
}
