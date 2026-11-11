// Every agent turn and config-plane request reads these, and Convex loads a file's whole
// import graph per call: import only the schema here.
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { accountDoc } from "./model/accountDoc";
import { agentDoc } from "./model/agentDoc";
import { rolePrincipalValidator } from "./model/policyDocument";
import { sandboxConfigDoc } from "./model/sandboxConfigDoc";
import { agentPoliciesFields } from "./schema";

export const agentDeploymentScopeValidator = v.object({
  accountId: v.id("accounts"),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
  endpointId: v.string(),
  projectSlug: v.string(),
  stageSlug: v.string(),
});

const deploymentPrincipal = v.object({
  ...agentDeploymentScopeValidator.fields,
  account: accountDoc,
  userTokenSecret: v.optional(
    v.object({ ciphertext: v.string(), iv: v.string(), tag: v.string() }),
  ),
});

export const policyDoc = v.object({
  ...agentPoliciesFields,
  _id: v.id("agentPolicies"),
  _creationTime: v.number(),
});

export const accountBySecretHash = internalQuery({
  args: { secretHash: v.string() },
  returns: v.union(accountDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"accounts"> | null> => {
    return await ctx.db
      .query("accounts")
      .withIndex("by_secretHash", (q) => q.eq("secretHash", args.secretHash))
      .unique();
  },
});

// `v.string()`, not `v.id`: an unknown id resolves to null instead of failing validation.
export const agentById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
  },
  returns: v.union(agentDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"agents"> | null> => {
    const normalized = ctx.db.normalizeId("agents", args.agentId);
    if (!normalized) return null;
    const agent = await ctx.db.get(normalized);
    if (!agent || agent.accountId !== args.accountId) {
      return null;
    }

    return agent;
  },
});

export const deploymentByApiKeyHash = internalQuery({
  args: { apiKeyHash: v.string() },
  // The signing secret stays sealed: core opens it only when a request carries a user token.
  returns: v.union(deploymentPrincipal, v.null()),
  handler: async (
    ctx,
    { apiKeyHash },
  ): Promise<Infer<typeof deploymentPrincipal> | null> => {
    const deployment = await ctx.db
      .query("agentDeployments")
      .withIndex("by_apiKeyHash", (q) => q.eq("apiKeyHash", apiKeyHash))
      .unique();
    if (!deployment || deployment.status !== "active") return null;

    const account = await ctx.db.get(deployment.accountId);
    if (!account || account.status !== "active") return null;

    return {
      accountId: deployment.accountId,
      projectId: deployment.projectId,
      stageId: deployment.stageId,
      endpointId: deployment.endpointId,
      projectSlug: deployment.projectSlug,
      stageSlug: deployment.stageSlug,
      account: account,
      ...(deployment.userTokenSecretCiphertext &&
      deployment.userTokenSecretIv &&
      deployment.userTokenSecretTag
        ? {
            userTokenSecret: {
              ciphertext: deployment.userTokenSecretCiphertext,
              iv: deployment.userTokenSecretIv,
              tag: deployment.userTokenSecretTag,
            },
          }
        : {}),
    };
  },
});

export const policyById = internalQuery({
  args: { accountId: v.id("accounts"), policyId: v.string() },
  returns: v.union(policyDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"agentPolicies"> | null> => {
    const normalized = ctx.db.normalizeId("agentPolicies", args.policyId);
    if (!normalized) return null;
    const policy = await ctx.db.get(normalized);
    if (
      !policy ||
      policy.accountId !== args.accountId ||
      policy.status !== "active"
    )
      return null;

    return policy;
  },
});

// The caller must load the account and check its status.
export const roleSessionByTokenHash = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(rolePrincipalValidator, v.null()),
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof rolePrincipalValidator> | null> => {
    const session = await ctx.db
      .query("roleSessions")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!session || session.expiresAt <= Date.now()) return null;
    const role = await getOwnedRole(ctx, session.accountId, session.roleId);
    if (!role || role.status !== "active") return null;

    return {
      accountId: role.accountId,
      roleId: role.roleId,
      policy: role.policy,
      ...(role.projectId !== undefined ? { projectId: role.projectId } : {}),
      ...(role.stageId !== undefined ? { stageId: role.stageId } : {}),
    };
  },
});

export const sandboxConfigById = internalQuery({
  args: {
    accountId: v.id("accounts"),
    sandboxId: v.string(),
  },
  returns: v.union(sandboxConfigDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"sandboxConfigs"> | null> => {
    const normalized = ctx.db.normalizeId("sandboxConfigs", args.sandboxId);
    if (!normalized) return null;
    const doc = await ctx.db.get(normalized);
    if (!doc || doc.accountId !== args.accountId) return null;

    return doc;
  },
});

export async function getOwnedRole(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  roleId: string,
): Promise<Doc<"accountRoles"> | null> {
  const role = await ctx.db
    .query("accountRoles")
    .withIndex("by_roleId", (q) => q.eq("roleId", roleId))
    .unique();

  return role && role.accountId === accountId ? role : null;
}
