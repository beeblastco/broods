/**
 * A stage's runtime-variable values and the rules for removing one. Keep the
 * encrypted-blob read here so callers never re-implement it.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256Hex } from "./accountSecrets";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
} from "./agentConfigCodec";
import { refreshAgentConfigsForEnvironmentVariable } from "./agentSync";
import { refreshSandboxConfigsForEnvironmentVariable } from "./sandboxConfigSync";

interface EnvironmentVariableWrite {
  id: Id<"environmentVariables">;
  change: "created" | "updated" | "unchanged";
}

/**
 * Stores a stage variable and re-resolves every agent and sandbox that reads
 * it. The dashboard and the CLI both write through here. A value whose digest
 * already matches writes nothing, so re-running `env set` does not rewrite
 * every config in the stage.
 */
export async function upsertEnvironmentVariable(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    name: string;
    value: string;
  },
): Promise<EnvironmentVariableWrite> {
  const existing = await ctx.db
    .query("environmentVariables")
    .withIndex("by_stageId_and_name", (q) =>
      q.eq("stageId", args.stageId).eq("name", args.name),
    )
    .unique();
  const valueDigest = await hashEnvironmentValue(args.value);
  if (existing?.valueDigest === valueDigest) {
    return { id: existing._id, change: "unchanged" };
  }
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to store environment variables",
    );
  }
  const encrypted = await encryptAgentConfigBlob({ value: args.value }, secret);
  const fields = {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    valueDigest: valueDigest,
    updatedAt: Date.now(),
  };
  let id: Id<"environmentVariables">;
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    id = existing._id;
  } else {
    id = await ctx.db.insert("environmentVariables", {
      projectId: args.projectId,
      stageId: args.stageId,
      name: args.name,
      ...fields,
    });
  }
  await refreshAgentConfigsForEnvironmentVariable(
    ctx,
    args.projectId,
    args.stageId,
    args.name,
    args.value,
  );
  await refreshSandboxConfigsForEnvironmentVariable(
    ctx,
    args.projectId,
    args.stageId,
    args.name,
    args.value,
  );

  return { id: id, change: existing ? "updated" : "created" };
}

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

/** SHA-256 hex of a plaintext value; the CLI hashes `.env.local` the same way to spot drift. */
export async function hashEnvironmentValue(value: string): Promise<string> {
  return await sha256Hex(value);
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
