import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { accountCipher, requireAccountIdForProject } from "./accountKeys";
import { ClientError } from "./clientError";

const REFERENCING_WORKSPACES_SHOWN = 10;

export async function assertEnvironmentVariableUnreferenced(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  name: string,
): Promise<void> {
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

// An undefined `stageId` reads the account-scoped workspaces, not every stage.
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
