/**
 * Shared loader for a stage's decrypted runtime-variable values, used by
 * CLI manifest sync and by the env-var change refresh paths that re-resolve
 * `${ENV_NAME}` placeholders. Keep value-decrypting logic here so callers never
 * re-implement the encrypted-blob read.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { decryptAgentConfigBlob } from "./agentConfigCodec";

/**
 * Reads every environment variable for a `(projectId, stageId)` and
 * returns a `name -> plaintext value` map. Non-string values decode to `""`.
 * @throws when `ACCOUNT_CONFIG_ENCRYPTION_SECRET` is not configured.
 */
export async function loadEnvironmentVariableValues(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): Promise<Record<string, string>> {
  const rows = await ctx.db
    .query("environmentVariables")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();

  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to read environment variables",
    );
  }

  const values: Record<string, string> = {};
  for (const row of rows) {
    const decrypted = await decryptAgentConfigBlob(
      { ciphertext: row.ciphertext, iv: row.iv, tag: row.tag },
      secret,
    );
    const value = decrypted?.value;
    values[row.name] = typeof value === "string" ? value : "";
  }

  return values;
}
