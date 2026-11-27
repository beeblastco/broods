import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  accountCipherForWrite,
  requireAccountIdForProject,
} from "./accountKeys";
import { assertEnvVarName } from "./agentConfigCodec";
import {
  accountIdForProject,
  appendAuditEvent,
  auditDetailsJson,
  type AuditActor,
} from "./auditEvents";
import { refreshAgentConfigsForEnvironmentVariable } from "./agentSync";
import { refreshSandboxConfigsForEnvironmentVariable } from "./sandboxConfigSync";

interface EnvironmentVariableWrite {
  id: Id<"environmentVariables">;
  change: "created" | "updated" | "unchanged";
}

// Audit details carry the name only, never the value.
export async function recordEnvironmentVariableAudit(
  ctx: MutationCtx,
  actor: AuditActor,
  input: {
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    variableId?: Id<"environmentVariables">;
    action: string;
    name: string;
    summary: string;
  },
): Promise<void> {
  const accountId = await accountIdForProject(ctx, input.projectId);
  if (!accountId) return;

  await appendAuditEvent(ctx.db, {
    accountId: accountId,
    projectId: input.projectId,
    stageId: input.stageId,
    actor: actor,
    action: input.action,
    resource: {
      kind: "environmentVariable",
      id: input.variableId,
      name: input.name,
    },
    summary: input.summary,
    detailsJson: auditDetailsJson({ name: input.name }),
  });
}

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
