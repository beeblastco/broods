/**
 * Persistent-sandbox instance registry scoped to an account. Mirrors broods's
 * sandbox reconnection state so the SaaS dashboard can show live instances and
 * drive suspend/resume/terminate through Convex live queries. broods owns the
 * provider lifecycle and writes each transition here through the internal
 * mutations; the dashboard reads via `listForActiveOrg` and writes through
 * `sandboxPublic` actions that proxy back to broods.
 *
 * `upsert` is the create-time populate keyed by reservationKey (carrying the size
 * `specs`), called when broods reserves a persistent sandbox; `setStatus`/`remove`
 * mirror later transitions; `listForActiveOrg` is the dashboard read.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { getActiveAccountForUser } from "./org";
import { sandboxInstancesFields } from "./schema";

const sandboxInstanceDoc = v.object({
    ...sandboxInstancesFields,
    _id: v.id("sandboxInstances"),
    _creationTime: v.number(),
});

/**
 * Public query: lists persistent sandbox instances for the caller's active org.
 * Used by the dashboard Sandbox tab for live status.
 * @returns the account's instance rows, or `[]` when no org/account resolves.
 */
export const listForActiveOrg = query({
    args: {
        projectId: v.id("projects"),
        environmentId: v.id("environments"),
    },
    returns: v.array(sandboxInstanceDoc),
    handler: async (ctx, args) => {
        const account = await getActiveAccountForUser(ctx);
        if (!account) return [];

        return await ctx.db
            .query("sandboxInstances")
            .withIndex("by_accountId_projectId_and_environmentId", (q) =>
                q.eq("accountId", account._id)
                    .eq("projectId", args.projectId)
                    .eq("environmentId", args.environmentId),
            )
            .take(100);
    },
});

/**
 * Create-or-refresh the registry row for a reserved sandbox, keyed by
 * reservationKey. Called by broods when it reserves a persistent instance so the
 * dashboard sees it live. Idempotent: refreshes the existing row (back to
 * `running`) on reconnect/re-reserve. No-op when the key belongs to another account.
 * @param accountId the owning account.
 * @param provider the sandbox compute backend.
 * @param reservationKey the broods reconnection key (globally unique).
 * @param externalId the provider-side instance id.
 * @param name the display name (the sandbox config's name).
 * @param specs the instance's vcpu/memory/disk footprint.
 * @param sandboxConfigId the sandbox config row this instance was reserved from.
 * @param snapshotId the snapshot/image the instance launched from, when pinned.
 */
export const upsert = internalMutation({
    args: {
        accountId: v.id("accounts"),
        projectId: v.optional(v.id("projects")),
        environmentId: v.optional(v.id("environments")),
        provider: sandboxInstancesFields.provider,
        reservationKey: v.string(),
        externalId: v.string(),
        name: v.string(),
        specs: sandboxInstancesFields.specs,
        sandboxConfigId: v.optional(v.id("sandboxConfigs")),
        snapshotId: v.optional(v.string()),
        egress: sandboxInstancesFields.egress,
        permissionMode: sandboxInstancesFields.permissionMode,
    },
    returns: v.null(),
    handler: async (ctx, args) => {
        const existing = await ctx.db
            .query("sandboxInstances")
            .withIndex("by_reservationKey", (q) => q.eq("reservationKey", args.reservationKey))
            .unique();
        if (existing && existing.accountId !== args.accountId) return null;

        const now = Date.now();
        const fields = {
            externalId: args.externalId,
            name: args.name,
            specs: args.specs,
            status: "running" as const,
            lastUsedAt: now,
            ...(args.projectId ? { projectId: args.projectId } : {}),
            ...(args.environmentId ? { environmentId: args.environmentId } : {}),
            ...(args.sandboxConfigId ? { sandboxConfigId: args.sandboxConfigId } : {}),
            ...(args.snapshotId ? { snapshotId: args.snapshotId } : {}),
            ...(args.egress ? { egress: args.egress } : {}),
            ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
        };
        if (existing) {
            await ctx.db.patch(existing._id, fields);

            return null;
        }

        await ctx.db.insert("sandboxInstances", {
            accountId: args.accountId,
            ...(args.projectId ? { projectId: args.projectId } : {}),
            ...(args.environmentId ? { environmentId: args.environmentId } : {}),
            provider: args.provider,
            reservationKey: args.reservationKey,
            createdAt: now,
            ...fields,
        });

        return null;
    },
});

/**
 * Internal action helper: verifies a dashboard lifecycle request targets an
 * instance owned by the active account and created from the supplied sandbox row.
 */
export const isControllable = internalQuery({
    args: {
        accountId: v.id("accounts"),
        sandboxConfigId: v.id("sandboxConfigs"),
        reservationKey: v.string(),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
        const instance = await ctx.db
            .query("sandboxInstances")
            .withIndex("by_reservationKey", (q) => q.eq("reservationKey", args.reservationKey))
            .unique();

        return Boolean(
            instance &&
            instance.accountId === args.accountId &&
            instance.sandboxConfigId === args.sandboxConfigId,
        );
    },
});

/**
 * Records a lifecycle transition (suspend/resume) for an instance, stamping the
 * matching timestamp. No-op when the key is unknown or belongs to another
 * account. Called by broods after the provider lifecycle call succeeds.
 * @param accountId the owning account.
 * @param reservationKey the broods reconnection key.
 * @param status the new lifecycle status.
 */
export const setStatus = internalMutation({
    args: {
        accountId: v.id("accounts"),
        reservationKey: v.string(),
        status: sandboxInstancesFields.status,
    },
    returns: v.null(),
    handler: async (ctx, { accountId, reservationKey, status }) => {
        const instance = await ctx.db
            .query("sandboxInstances")
            .withIndex("by_reservationKey", (q) => q.eq("reservationKey", reservationKey))
            .unique();
        if (!instance || instance.accountId !== accountId) return null;

        const now = Date.now();
        await ctx.db.patch(instance._id, {
            status,
            lastUsedAt: now,
            ...(status === "suspended" ? { suspendedAt: now } : {}),
            ...(status === "terminating" ? { terminatedAt: now } : {}),
        });

        return null;
    },
});

/**
 * Drops an instance row when broods terminates the sandbox or releases the
 * reservation. No-op when the key is unknown or belongs to another account.
 * @param accountId the owning account.
 * @param reservationKey the broods reconnection key.
 */
export const remove = internalMutation({
    args: {
        accountId: v.id("accounts"),
        reservationKey: v.string(),
    },
    returns: v.null(),
    handler: async (ctx, { accountId, reservationKey }) => {
        const instance = await ctx.db
            .query("sandboxInstances")
            .withIndex("by_reservationKey", (q) => q.eq("reservationKey", reservationKey))
            .unique();
        if (instance && instance.accountId === accountId) {
            await ctx.db.delete(instance._id);
        }

        return null;
    },
});
