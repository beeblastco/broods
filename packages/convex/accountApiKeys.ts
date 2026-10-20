/**
 * Scoped account keys (`bask_…`) made on Organization › API access. Each is
 * an allow list over the API actions, optionally pinned to one project and
 * stage, with an optional expiry; the bearer resolvers turn it into a role
 * principal (`account/apiKeys.ts`). The org's own account key is untouched
 * here: it stays in `accounts.secretHash` and rotates in `org/lifecycle`.
 * Every write needs `keys:write` for the organization.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { resolveRoleScope } from "./account/roles";
import { authKit } from "./auth";
import { requireDashboardPermission } from "./model/access";
import {
  ACCOUNT_KEY_PREFIX,
  keyHint,
  randomToken,
  sha256Hex,
} from "./model/accountSecrets";
import {
  appendAuditEvent,
  auditDetailsJson,
  dashboardAuditActor,
} from "./model/auditEvents";
import { ClientError } from "./model/clientError";
import {
  API_POLICY_ACTIONS,
  type ApiPolicyAction,
  type PolicyDocument,
} from "./model/policyRules";
import { userByAuthId } from "./model/ownership/org";

/** The API actions a key may be granted, as the dashboard's permission grid sends them. */
export const keyActionsValidator = v.array(
  v.union(...API_POLICY_ACTIONS.map((action) => v.literal(action))),
);

type KeyWriter = {
  account: Doc<"accounts">;
  member: Doc<"users">;
  user: { id: string; email?: string | null; name?: string | null };
};

export const create = mutation({
  args: {
    orgId: v.id("orgs"),
    name: v.string(),
    description: v.optional(v.string()),
    actions: keyActionsValidator,
    projectId: v.optional(v.id("projects")),
    stageId: v.optional(v.id("stages")),
    expiresAt: v.optional(v.number()),
  },
  returns: v.object({
    _id: v.id("accountApiKeys"),
    token: v.string(),
    keyHint: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ _id: Id<"accountApiKeys">; token: string; keyHint: string }> => {
    const writer = await requireKeyWriter(ctx, args.orgId);
    const now = Date.now();
    requireFutureExpiry(args.expiresAt, now);
    const scope = await resolveRoleScope(
      ctx,
      writer.account._id,
      args.projectId,
      args.stageId,
    );
    const token = randomToken(ACCOUNT_KEY_PREFIX);
    const hint = keyHint(ACCOUNT_KEY_PREFIX, token);
    const name = requiredName(args.name);
    const _id = await ctx.db.insert("accountApiKeys", {
      accountId: writer.account._id,
      ...scope,
      name: name,
      description: args.description?.trim() || undefined,
      keyHash: await sha256Hex(token),
      keyHint: hint,
      policy: keyPolicy(args.actions),
      expiresAt: args.expiresAt,
      createdBy: writer.member._id,
      createdAt: now,
      updatedAt: now,
    });
    await recordKeyAudit(ctx, writer, "account-key-created", _id, name, {
      actions: args.actions,
      expiresAt: args.expiresAt,
      ...scope,
    });

    return { _id: _id, token: token, keyHint: hint };
  },
});

/** Revoking deletes the row, so the key stops authenticating at once. */
export const remove = mutation({
  args: { orgId: v.id("orgs"), keyId: v.id("accountApiKeys") },
  returns: v.id("accountApiKeys"),
  handler: async (ctx, args): Promise<Id<"accountApiKeys">> => {
    const writer = await requireKeyWriter(ctx, args.orgId);
    const key = await ownedKey(ctx, writer, args.keyId);
    await ctx.db.delete(key._id);
    await recordKeyAudit(ctx, writer, "account-key-revoked", key._id, key.name);

    return key._id;
  },
});

/**
 * Change one or more of a key's fields in place, as the dashboard edits them
 * inline. An omitted field is kept; `scope: {}` unpins the key and
 * `expiresAt: null` makes it never expire. The secret never changes.
 */
export const update = mutation({
  args: {
    orgId: v.id("orgs"),
    keyId: v.id("accountApiKeys"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    actions: v.optional(keyActionsValidator),
    scope: v.optional(
      v.object({
        projectId: v.optional(v.id("projects")),
        stageId: v.optional(v.id("stages")),
      }),
    ),
    expiresAt: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.id("accountApiKeys"),
  handler: async (ctx, args): Promise<Id<"accountApiKeys">> => {
    const writer = await requireKeyWriter(ctx, args.orgId);
    const key = await ownedKey(ctx, writer, args.keyId);
    const now = Date.now();
    requireFutureExpiry(args.expiresAt ?? undefined, now);
    const scope = args.scope
      ? await resolveRoleScope(
          ctx,
          writer.account._id,
          args.scope.projectId,
          args.scope.stageId,
        )
      : undefined;
    const name = args.name === undefined ? key.name : requiredName(args.name);
    const patch: Partial<Doc<"accountApiKeys">> = {
      name: name,
      ...(args.description !== undefined
        ? { description: args.description.trim() || undefined }
        : {}),
      ...(args.actions ? { policy: keyPolicy(args.actions) } : {}),
      ...(args.scope
        ? { projectId: scope?.projectId, stageId: scope?.stageId }
        : {}),
      ...(args.expiresAt !== undefined
        ? { expiresAt: args.expiresAt ?? undefined }
        : {}),
      updatedAt: now,
    };
    await ctx.db.patch(key._id, patch);
    await recordKeyAudit(ctx, writer, "account-key-updated", key._id, name, {
      actions: args.actions,
      scope: args.scope,
      expiresAt: args.expiresAt,
    });

    return key._id;
  },
});

/** One allow rule over the picked actions, as `authorize()` reads a role. */
function keyPolicy(actions: ApiPolicyAction[]): PolicyDocument {
  if (actions.length === 0) {
    throw new ClientError("Pick at least one permission");
  }

  return {
    version: 1,
    rules: [
      {
        id: "key",
        effect: "allow",
        actions: [...new Set(actions)].sort(),
      },
    ],
  };
}

/** A key of this org's account; anything else reads as not found. */
async function ownedKey(
  ctx: MutationCtx,
  writer: KeyWriter,
  keyId: Id<"accountApiKeys">,
): Promise<Doc<"accountApiKeys">> {
  const key = await ctx.db.get(keyId);
  if (!key || key.accountId !== writer.account._id) {
    throw new ClientError("Key not found", "not_found");
  }

  return key;
}

async function recordKeyAudit(
  ctx: MutationCtx,
  writer: KeyWriter,
  action: string,
  keyId: Id<"accountApiKeys">,
  name: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await appendAuditEvent(ctx.db, {
    accountId: writer.account._id,
    actor: dashboardAuditActor(writer.user),
    action: action,
    resource: { kind: "accountApiKey", id: keyId, name: name },
    summary: `${action.replace(/-/g, " ")}: ${name}`,
    ...(details ? { detailsJson: auditDetailsJson(details) } : {}),
  });
}

function requiredName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ClientError("Name the key");

  return trimmed;
}

/** Refuse an expiry already past; unset is "never". */
function requireFutureExpiry(expiresAt: number | undefined, now: number): void {
  if (expiresAt !== undefined && expiresAt <= now) {
    throw new ClientError("Expiry must be in the future");
  }
}

/** The caller, holding `keys:write` on the org, and the org's provisioned account. */
async function requireKeyWriter(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
): Promise<KeyWriter> {
  // Check authenticated user
  const user = await authKit.getAuthUser(ctx);
  if (!user) {
    throw new Error("User not found or not authenticated");
  }
  const member = await userByAuthId(ctx, user.id);
  if (!member) throw new Error("User row not found");
  await requireDashboardPermission(ctx, orgId, member, "keys:write");
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .unique();
  if (!account) {
    throw new ClientError("Provision the organization's API account first");
  }

  return { account: account, member: member, user: user };
}
