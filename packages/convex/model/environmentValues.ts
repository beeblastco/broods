/**
 * A stage's runtime-variable values and the rules for removing one. Keep the
 * encrypted-blob read here so callers never re-implement it.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { decryptAgentConfigBlob } from "./agentConfigCodec";

/**
 * Refuses to remove a variable that a synced resource still reads through
 * `env("NAME")`, which would leave it holding an unresolvable `${NAME}`.
 * @throws naming the resources that still reference it.
 */
export async function assertEnvironmentVariableUnreferenced(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  name: string,
): Promise<void> {
  // Both tables record their `env()` refs the same way, as a `runtimeVariables`
  // key, which is what the refresh helpers match on too.
  const agents = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  const sandboxes = await ctx.db
    .query("sandboxConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const referencing = [
    ...agents
      .filter((entry) =>
        entry.runtimeVariables?.some((variable) => variable.key === name),
      )
      .map((entry) => `agent "${entry.name}"`),
    ...sandboxes
      .filter((entry) =>
        entry.runtimeVariables?.some((variable) => variable.key === name),
      )
      .map((entry) => `sandbox "${entry.name}"`),
  ].sort();
  if (referencing.length === 0) return;

  throw new Error(
    `${name} is still referenced by ${referencing.join(", ")}. ` +
      `Remove the env("${name}") reference from those resources and sync before deleting the variable.`,
  );
}

/**
 * SHA-256 hex of a variable's plaintext value, stored beside the ciphertext as
 * `valueDigest`. The CLI hashes its `.env.local` value the same way, so the two
 * sides can be compared for drift without either one revealing the secret.
 */
export async function hashEnvironmentValue(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

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
