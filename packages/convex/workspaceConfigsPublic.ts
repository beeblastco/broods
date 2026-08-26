/**
 * Dashboard-facing working-folder creation for the agent Context tab
 * (ticket 18, executing superseded ticket 07's backend). One mutation gives
 * an agent a real working folder: a stage-scoped `workspaceConfigs` row, a
 * default sandbox ensured (the file tools need a machine), and the refs
 * attached through the agent config — narrow-and-add only, per the
 * apps/core/CLAUDE.md invariant: attaching adds capability refs, never
 * escalates or rewrites anything else the agent had.
 */

import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authKit } from "./auth";
import { encryptAgentConfigBlob } from "./model/agentConfigCodec";
import { pushEncryptedConfigToAgentRow } from "./model/agentSync";
import { resolveAgentConversationScope } from "./model/conversationHistory";
import {
  withWorkingFolder,
  withoutWorkingFolder,
  workspaceRefsOf,
} from "./model/workingFolders";

/** Default folder storage: the S3-backed workspace every other path uses. */
const DEFAULT_WORKSPACE_CONFIG = { storage: { provider: "s3" } };
/** Default machine: sandbox provider, ask-before-edit, no network. */
const DEFAULT_SANDBOX_CONFIG = {
  provider: "sandbox",
  permissionMode: "ask",
  network: { mode: "deny-all" },
};

/** The agent's current extraConfig, as a plain mutable record. */
function extraConfigOf(config: Doc<"agentConfigs">): Record<string, unknown> {
  return { ...(config.extraConfig as Record<string, unknown> | undefined) };
}

/** Reject a same-name legacy account-scoped row (mirrors canvas.ts's guard). */
async function assertNoAccountScopedConflict(
  ctx: MutationCtx,
  table: "workspaceConfigs" | "sandboxConfigs",
  accountId: Id<"accounts">,
  name: string,
): Promise<void> {
  const rows = await ctx.db
    .query(table)
    .withIndex("by_accountId_and_name", (q) =>
      q.eq("accountId", accountId).eq("name", name),
    )
    .collect();
  if (rows.some((row) => row.stageId === undefined)) {
    throw new Error(
      `A ${table === "workspaceConfigs" ? "folder" : "machine"} named "${name}" already exists at the account level. Pick another name.`,
    );
  }
}

export const createWorkingFolder = mutation({
  args: {
    configId: v.id("agentConfigs"),
    name: v.string(),
  },
  returns: v.object({
    workspaceId: v.string(),
    sandboxId: v.string(),
    createdSandbox: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const scope = await resolveAgentConversationScope(
      ctx,
      user.id,
      args.configId,
    );
    if (!scope) {
      throw new Error("Agent not found or not deployed yet.");
    }
    const config = await ctx.db.get(args.configId);
    if (!config) throw new Error("Agent not found.");

    const name = args.name.trim();
    if (!name) throw new Error("Folder name must not be empty.");
    const extra = extraConfigOf(config);
    const existingRefs = workspaceRefsOf(extra);
    if (existingRefs.some((ref) => ref.name === name)) {
      throw new Error(`This agent already has a folder named "${name}".`);
    }

    const now = Date.now();
    await assertNoAccountScopedConflict(
      ctx,
      "workspaceConfigs",
      scope.accountId,
      name,
    );
    const workspaceId = await ctx.db.insert("workspaceConfigs", {
      accountId: scope.accountId,
      projectId: config.projectId,
      stageId: config.stageId,
      name: name,
      config: DEFAULT_WORKSPACE_CONFIG,
      managedBy: "dashboard",
      createdAt: now,
      updatedAt: now,
    });

    // The file tools need a machine: ensure one when the agent has none.
    let sandboxId =
      typeof extra.sandbox === "string" && extra.sandbox.trim().length > 0
        ? extra.sandbox
        : null;
    let createdSandbox = false;
    if (!sandboxId) {
      const sandboxName = `${config.name}-machine`;
      await assertNoAccountScopedConflict(
        ctx,
        "sandboxConfigs",
        scope.accountId,
        sandboxName,
      );
      const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
      const encrypted = secret
        ? await encryptAgentConfigBlob(DEFAULT_SANDBOX_CONFIG, secret)
        : null;
      const newSandboxId = await ctx.db.insert("sandboxConfigs", {
        accountId: scope.accountId,
        projectId: config.projectId,
        stageId: config.stageId,
        name: sandboxName,
        ...(encrypted
          ? {
              encryptedConfig: encrypted.ciphertext,
              encryptionIv: encrypted.iv,
              encryptionTag: encrypted.tag,
            }
          : {}),
        managedBy: "dashboard",
        createdAt: now,
        updatedAt: now,
      });
      sandboxId = newSandboxId as string;
      createdSandbox = true;
    }

    // Narrow-and-add: only append the new refs; every other branch and every
    // existing ref stays byte-identical (model/workingFolders.ts, unit-tested).
    await ctx.db.patch(args.configId, {
      extraConfig: withWorkingFolder(
        extra,
        { name: name, workspaceId: workspaceId as string },
        sandboxId,
      ),
      updatedAt: now,
    });
    await pushEncryptedConfigToAgentRow(ctx, args.configId);

    return {
      workspaceId: workspaceId as string,
      sandboxId: sandboxId,
      createdSandbox: createdSandbox,
    };
  },
});

export const detachWorkingFolder = mutation({
  args: {
    configId: v.id("agentConfigs"),
    workspaceId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const scope = await resolveAgentConversationScope(
      ctx,
      user.id,
      args.configId,
    );
    if (!scope) {
      throw new Error("Agent not found or not deployed yet.");
    }
    const config = await ctx.db.get(args.configId);
    if (!config) throw new Error("Agent not found.");

    const extra = extraConfigOf(config);
    const refs = workspaceRefsOf(extra);
    if (!refs.some((ref) => ref.workspaceId === args.workspaceId)) return null;

    // Narrow removal: drop exactly this ref; the folder row, the sandbox, and
    // every other attachment stay untouched (model/workingFolders.ts).
    await ctx.db.patch(args.configId, {
      extraConfig: withoutWorkingFolder(extra, args.workspaceId),
      updatedAt: Date.now(),
    });
    await pushEncryptedConfigToAgentRow(ctx, args.configId);

    return null;
  },
});
