/**
 * Writes a stage's runtime variable and re-resolves every agent and sandbox
 * config that reads it. Above the reader (`environmentValues.ts`) and the
 * refreshes, so neither of those imports back into the write.
 */

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  accountCipherForWrite,
  requireAccountIdForProject,
} from "./accountKeys";
import { assertEnvVarName } from "./agentConfigCodec";
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
