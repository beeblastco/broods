/**
 * Public CRUD for per-stage runtime variables, mirrored into the CLI
 * sync model. Scoped to the authenticated project owner.
 */

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { authKit } from "./auth";
import { getOwnedStage } from "./model/ownership/stage";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
} from "./model/agentConfigCodec";
import { refreshAgentConfigsForEnvironmentVariable } from "./model/agentSync";
import {
  assertEnvironmentVariableUnreferenced,
  hashEnvironmentValue,
} from "./model/environmentValues";
import { refreshSandboxConfigsForEnvironmentVariable } from "./model/sandboxConfigSync";
import {
  accountIdForProject,
  auditDetailsJson,
  dashboardAuditActor,
  insertConfigAuditEvent,
  type ConfigAuditActor,
} from "./model/auditEvents";

const environmentVariableDoc = v.object({
  _id: v.id("environmentVariables"),
  _creationTime: v.number(),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  name: v.string(),
  value: v.string(),
  updatedAt: v.number(),
});

function encryptionSecret(): string {
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to store environment variables",
    );
  }

  return secret;
}

function maskEnvironmentVariable(variable: {
  _id: Id<"environmentVariables">;
  _creationTime: number;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
  name: string;
  updatedAt: number;
}) {
  return {
    _id: variable._id,
    _creationTime: variable._creationTime,
    projectId: variable.projectId,
    stageId: variable.stageId,
    name: variable.name,
    value: "********",
    updatedAt: variable.updatedAt,
  };
}

/** Record an environment-variable mutation without storing plaintext values. */
async function recordEnvironmentVariableAudit(
  ctx: MutationCtx,
  actor: ConfigAuditActor,
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

  await insertConfigAuditEvent(ctx.db, {
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

export const list = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.array(environmentVariableDoc),
  handler: async (ctx, { projectId, stageId }) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    // Return empty rather than throwing so a just-deleted stage doesn't
    // crash reactive subscribers before they unmount.
    const stage = await getOwnedStage(ctx, user.id, stageId);
    if (!stage || stage.projectId !== projectId) {
      return [];
    }

    const variables = await ctx.db
      .query("environmentVariables")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stageId),
      )
      .collect();

    return variables.map(maskEnvironmentVariable);
  },
});

/**
 * Upserts a variable by name within a stage: patches the value when the
 * name already exists, otherwise inserts a new row.
 */
export const set = mutation({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    name: v.string(),
    value: v.string(),
  },
  returns: v.id("environmentVariables"),
  handler: async (ctx, { projectId, stageId, name, value }) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const stage = await getOwnedStage(ctx, user.id, stageId);
    if (!stage || stage.projectId !== projectId) {
      throw new Error("Stage not found.");
    }

    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Variable name is required.");

    const existing = await ctx.db
      .query("environmentVariables")
      .withIndex("by_stageId_and_name", (q) =>
        q.eq("stageId", stageId).eq("name", trimmedName),
      )
      .unique();

    const now = Date.now();
    const encrypted = await encryptAgentConfigBlob(
      { value: value },
      encryptionSecret(),
    );
    const valueDigest = await hashEnvironmentValue(value);
    if (existing) {
      await ctx.db.patch(existing._id, {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        valueDigest: valueDigest,
        updatedAt: now,
      });

      await refreshAgentConfigsForEnvironmentVariable(
        ctx,
        projectId,
        stageId,
        trimmedName,
        value,
      );
      await refreshSandboxConfigsForEnvironmentVariable(
        ctx,
        projectId,
        stageId,
        trimmedName,
        value,
      );
      await recordEnvironmentVariableAudit(ctx, dashboardAuditActor(user), {
        projectId: projectId,
        stageId: stageId,
        variableId: existing._id,
        action: "updated",
        name: trimmedName,
        summary: "Environment variable updated",
      });

      return existing._id;
    }

    const variableId = await ctx.db.insert("environmentVariables", {
      projectId: projectId,
      stageId: stageId,
      name: trimmedName,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      valueDigest: valueDigest,
      updatedAt: now,
    });

    await refreshAgentConfigsForEnvironmentVariable(
      ctx,
      projectId,
      stageId,
      trimmedName,
      value,
    );
    await refreshSandboxConfigsForEnvironmentVariable(
      ctx,
      projectId,
      stageId,
      trimmedName,
      value,
    );
    await recordEnvironmentVariableAudit(ctx, dashboardAuditActor(user), {
      projectId: projectId,
      stageId: stageId,
      variableId: variableId,
      action: "created",
      name: trimmedName,
      summary: "Environment variable created",
    });

    return variableId;
  },
});

/**
 * Decrypts and returns one variable's plaintext value for the dashboard eye-icon
 * reveal, writing an audit record of the reveal. A mutation (not a query) so the
 * audit insert and decryption happen atomically for the owning user.
 * @throws when the caller does not own the stage or the variable is gone
 */
export const reveal = mutation({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    variableId: v.id("environmentVariables"),
  },
  returns: v.object({ value: v.string() }),
  handler: async (ctx, { projectId, stageId, variableId }) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const stage = await getOwnedStage(ctx, user.id, stageId);
    if (!stage || stage.projectId !== projectId) {
      throw new Error("Stage not found.");
    }

    const variable = await ctx.db.get(variableId);
    if (!variable || variable.stageId !== stageId) {
      throw new Error("Variable not found.");
    }

    const decrypted = await decryptAgentConfigBlob(
      { ciphertext: variable.ciphertext, iv: variable.iv, tag: variable.tag },
      encryptionSecret(),
    );
    const revealed = decrypted as { value?: unknown } | null;
    const value = typeof revealed?.value === "string" ? revealed.value : "";

    await ctx.db.insert("environmentVariableReveals", {
      projectId: projectId,
      stageId: stageId,
      environmentVariableId: variableId,
      name: variable.name,
      source: "dashboard",
      revealedByAuthId: user.id,
      revealedAt: Date.now(),
    });

    return { value: value };
  },
});

export const remove = mutation({
  args: { variableId: v.id("environmentVariables") },
  returns: v.id("environmentVariables"),
  handler: async (ctx, { variableId }) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const variable = await ctx.db.get(variableId);
    if (!variable) throw new Error("Variable not found.");

    const stage = await getOwnedStage(ctx, user.id, variable.stageId);
    if (!stage) throw new Error("Variable not found.");
    await assertEnvironmentVariableUnreferenced(
      ctx,
      variable.projectId,
      variable.stageId,
      variable.name,
    );

    await ctx.db.delete(variableId);
    await refreshAgentConfigsForEnvironmentVariable(
      ctx,
      variable.projectId,
      variable.stageId,
      variable.name,
      undefined,
    );
    await refreshSandboxConfigsForEnvironmentVariable(
      ctx,
      variable.projectId,
      variable.stageId,
      variable.name,
      undefined,
    );
    await recordEnvironmentVariableAudit(ctx, dashboardAuditActor(user), {
      projectId: variable.projectId,
      stageId: variable.stageId,
      variableId: variableId,
      action: "deleted",
      name: variable.name,
      summary: "Environment variable deleted",
    });

    return variableId;
  },
});
