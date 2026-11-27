import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { accountCipherForWrite, hasEncryptionSecret } from "./accountKeys";
import { substituteEnvPlaceholders } from "./agentConfigCodec";
import { loadEnvironmentVariableValues } from "./environmentValues";
import { assertSnapshotInScope } from "../sandbox/snapshots";

export async function refreshSandboxConfigsForEnvironmentVariable(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  name: string,
  value: string | undefined,
): Promise<void> {
  if (!hasEncryptionSecret()) return;

  const configs = await ctx.db
    .query("sandboxConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const referencing = configs.filter((config) =>
    config.runtimeVariables?.some((entry) => entry.key === name),
  );
  if (referencing.length === 0) return;

  // Substitute every var at once, or the sandbox's other refs stay literal `${OTHER}`.
  const values = await loadEnvironmentVariableValues(ctx, projectId, stageId);
  if (value === undefined) delete values[name];

  for (const config of referencing) {
    if (
      !config.encryptedSourceConfig ||
      !config.sourceEncryptionIv ||
      !config.sourceEncryptionTag
    ) {
      continue;
    }
    const cipher = await accountCipherForWrite(ctx, config.accountId);
    const source = await cipher.decrypt(
      "sandboxConfigs:encryptedSourceConfig",
      {
        ciphertext: config.encryptedSourceConfig,
        iv: config.sourceEncryptionIv,
        tag: config.sourceEncryptionTag,
      },
    );
    if (!source) continue;

    const resolved = substituteEnvPlaceholders(source, values);
    if (resolved.snapshot !== source.snapshot) {
      await assertSnapshotInScope(
        ctx,
        config.accountId,
        { projectId: projectId, stageId: stageId },
        resolved.snapshot,
      );
    }
    const encrypted = await cipher.encrypt(
      "sandboxConfigs:encryptedConfig",
      resolved,
    );
    await ctx.db.patch(config._id, {
      encryptedConfig: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
      updatedAt: Date.now(),
    });
  }
}
