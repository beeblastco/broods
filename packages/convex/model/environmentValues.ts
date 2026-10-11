/**
 * A stage's runtime-variable values and the rules for removing one. Keep the
 * encrypted-blob read here so callers never re-implement it. Read-only: the
 * write that re-resolves what reads a variable is `environmentWrites.ts`, which
 * sits above both this reader and the config refreshes it drives.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { accountCipher, requireAccountIdForProject } from "./accountKeys";
import { ClientError } from "./clientError";

// How many referencing workspaces an env var delete refusal reads and names.
const REFERENCING_WORKSPACES_SHOWN = 10;

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
  const workspaces = await workspacesReferencingEnvVar(
    ctx,
    await requireAccountIdForProject(ctx, projectId),
    stageId,
    name,
  );
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
    ...workspaces.map((entry) => `workspace "${entry.name}"`),
  ].sort();
  if (referencing.length === 0) return;

  throw new ClientError(
    `${name} is still referenced by ${referencing.join(", ")}. ` +
      `Remove the env("${name}") reference from those resources and sync before deleting the variable.`,
    "conflict",
  );
}

/**
 * The workspaces in one stage, or the account-scoped ones when `stageId` is
 * undefined, whose R2 keys reference env var `name`. Indexed, so it reads only
 * referencing rows; the first few are enough to refuse a delete and name them.
 */
export async function workspacesReferencingEnvVar(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
  stageId: Id<"stages"> | undefined,
  name: string,
): Promise<Doc<"workspaceConfigs">[]> {
  const [byAccessKey, bySecretKey] = await Promise.all([
    ctx.db
      .query("workspaceConfigs")
      .withIndex("by_accountId_r2AccessKeyEnv_and_stageId", (q) =>
        q
          .eq("accountId", accountId)
          .eq("r2AccessKeyEnv", name)
          .eq("stageId", stageId),
      )
      .take(REFERENCING_WORKSPACES_SHOWN),
    ctx.db
      .query("workspaceConfigs")
      .withIndex("by_accountId_r2SecretAccessKeyEnv_and_stageId", (q) =>
        q
          .eq("accountId", accountId)
          .eq("r2SecretAccessKeyEnv", name)
          .eq("stageId", stageId),
      )
      .take(REFERENCING_WORKSPACES_SHOWN),
  ]);

  return [
    ...new Map(
      [...byAccessKey, ...bySecretKey].map((row) => [row._id, row]),
    ).values(),
  ];
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
      )
        .filter((row) => row !== null)
        .filter((row) => row.projectId === projectId)
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
