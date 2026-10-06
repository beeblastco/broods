/**
 * A stage's runtime-variable values and the rules for removing one. Keep the
 * encrypted-blob read here so callers never re-implement it.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  accountCipher,
  accountCipherForWrite,
  requireAccountIdForProject,
} from "./accountKeys";
import { assertEnvVarName } from "./agentConfigCodec";
import { refreshAgentConfigsForEnvironmentVariable } from "./agentSync";
import { refreshSandboxConfigsForEnvironmentVariable } from "./sandboxConfigSync";
import { ClientError } from "./clientError";

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
  assertEnvVarName(args.name);
  const existing = await ctx.db
    .query("environmentVariables")
    .withIndex("by_stageId_and_name", (q) =>
      q.eq("stageId", args.stageId).eq("name", args.name),
    )
    .unique();
  const cipher = await accountCipherForWrite(
    ctx,
    await requireAccountIdForProject(ctx, args.projectId),
  );
  const valueDigest = await cipher.digest(args.value);
  if (existing?.valueDigest === valueDigest) {
    return { id: existing._id, change: "unchanged" };
  }
  const encrypted = await cipher.encrypt("environmentVariables:ciphertext", {
    value: args.value,
  });
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

  throw new ClientError(
    `${name} is still referenced by ${referencing.join(", ")}. ` +
      `Remove the env("${name}") reference from those resources and sync before deleting the variable.`,
    "conflict",
  );
}

/**
 * Reads the environment variables for a `(projectId, stageId)`, every one or
 * only `names`, and returns a `name -> plaintext value` map. A name the stage
 * lacks is absent. Non-string values decode to `""`.
 * @throws when `ACCOUNT_CONFIG_ENCRYPTION_SECRET` is not configured.
 */
export async function loadEnvironmentVariableValues(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  names?: readonly string[],
): Promise<Record<string, string>> {
  const rows = names
    ? (
        await Promise.all(
          names.map((name) =>
            ctx.db
              .query("environmentVariables")
              .withIndex("by_stageId_and_name", (q) =>
                q.eq("stageId", stageId).eq("name", name),
              )
              .unique(),
          ),
        )
      ).filter((row) => row !== null)
    : await ctx.db
        .query("environmentVariables")
        .withIndex("by_projectId_and_stageId", (q) =>
          q.eq("projectId", projectId).eq("stageId", stageId),
        )
        .collect();

  const cipher = await accountCipher(
    ctx,
    await requireAccountIdForProject(ctx, projectId),
  );
  const decrypted = await Promise.all(
    rows.map((row) => cipher.decrypt("environmentVariables:ciphertext", row)),
  );
  const values: Record<string, string> = {};
  rows.forEach((row, index) => {
    const value = decrypted[index]?.value;
    values[row.name] = typeof value === "string" ? value : "";
  });

  return values;
}
