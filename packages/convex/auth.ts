/**
 * WorkOS AuthKit integration and event handlers for user authentication lifecycle.
 * Read more: https://www.convex.dev/components/workos-authkit
 */

import { AuthKit } from "@convex-dev/workos-authkit";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";

/**
 * AuthKit instance for WorkOS authentication with Convex.
 */
export const authKit: AuthKit<DataModel> = new AuthKit<DataModel>(components.workOSAuthKit, {
    authFunctions: internal.auth,
});

/**
 * WorkOS webhook event handlers for user lifecycle management.
 */
export const { authKitEvent } = authKit.events({
    "user.created": async (ctx, event) => {
        const firstName = event.data.firstName ?? "";
        const lastName = event.data.lastName ?? "";
        const name = `${firstName} ${lastName}`.trim() || event.data.email;
        const avatarUrl =
            (event.data as { picture?: string | null }).picture ?? undefined;

        const existing = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", event.data.id))
            .first();

        if (existing) {
            await ctx.db.patch(existing._id, {
                email: event.data.email,
                name: name,
                avatarUrl: avatarUrl,
            });
            return;
        }

        await ctx.db.insert("users", {
            authId: event.data.id,
            email: event.data.email,
            name: name,
            avatarUrl: avatarUrl,
            accountHandle: undefined,
            plan: "free",
            deletionScheduledFor: undefined,
        });
    },
    "user.updated": async (ctx, event) => {
        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", event.data.id))
            .first();
        if (!user) {
            console.warn(`User not found for update: ${event.data.id}`);
            return;
        }
        const firstName = event.data.firstName ?? "";
        const lastName = event.data.lastName ?? "";
        const name = `${firstName} ${lastName}`.trim() || event.data.email;
        const picture = (event.data as { picture?: string | null }).picture;
        const avatarUrl = picture === null ? undefined : (picture ?? user.avatarUrl);

        await ctx.db.patch(user._id, {
            email: event.data.email,
            name: name,
            avatarUrl: avatarUrl,
        });
    },
    "user.deleted": async (ctx, event) => {
        const user = await ctx.db
            .query("users")
            .withIndex("by_authId", (q) => q.eq("authId", event.data.id))
            .first();
        if (!user) {
            console.warn(`User not found for deletion: ${event.data.id}`);
            return;
        }
        await ctx.db.delete(user._id);
    },
    "session.created": async () => { },
    "session.revoked": async () => { },
});

/**
 * WorkOS action handlers for controlling authentication and registration behavior.
 */
export const { authKitAction } = authKit.actions({
    authentication: async (_ctx, _action, response) => {
        return response.allow();
    },
    userRegistration: async (_ctx, _action, response) => {
        return response.allow();
    },
});
