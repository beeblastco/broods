import { AuthKit, type AuthFunctions } from "@convex-dev/workos-authkit";
import { components, internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { releaseSeat } from "./model/orgBilling";
import { syncInvited } from "./model/ownership/org";
import { isManagedService } from "./model/planLimits";
import { authProvider } from "./model/selfHostAuth";

// Self-hosted never calls WorkOS (`user.ensureSynced` seeds its admin), so it needs no keys.
const selfHosted = authProvider() === "self-host";

export const authKit: AuthKit<DataModel> = new AuthKit<DataModel>(
  components.workOSAuthKit,
  {
    // Codegen types these from the component's `v.record` returns, wider than `AuthFunctions`.
    authFunctions: internal.auth as AuthFunctions,
    ...(selfHosted
      ? {
          apiKey: "self-hosted",
          clientId: "self-hosted",
          webhookSecret: "self-hosted",
        }
      : {}),
  },
);

export type AuthUser = NonNullable<
  Awaited<ReturnType<typeof authKit.getAuthUser>>
>;

export const { authKitAction } = authKit.actions({
  authentication: async (_ctx, _action, response) => response.allow(),
  userRegistration: async (_ctx, _action, response) => response.allow(),
});

export const { authKitEvent } = authKit.events({
  "user.created": async (ctx, event): Promise<void> => {
    const avatarUrl =
      (event.data as { picture?: string | null }).picture ?? undefined;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", event.data.id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        email: event.data.email.toLowerCase(),
        name: existing.nameEdited ? existing.name : deriveName(event.data),
        avatarUrl: avatarUrl,
      });
      await claimInvitations(ctx, existing._id, event.data);

      return;
    }

    const userId = await ctx.db.insert("users", {
      authId: event.data.id,
      email: event.data.email.toLowerCase(),
      name: deriveName(event.data),
      avatarUrl: avatarUrl,
      accountHandle: undefined,
      plan: "free",
      deletionScheduledFor: undefined,
    });
    await claimInvitations(ctx, userId, event.data);
  },
  "user.updated": async (ctx, event): Promise<void> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", event.data.id))
      .first();
    if (!user) {
      console.warn(`User not found for update: ${event.data.id}`);

      return;
    }
    const picture = (event.data as { picture?: string | null }).picture;
    const avatarUrl =
      picture === null ? undefined : (picture ?? user.avatarUrl);

    await ctx.db.patch(user._id, {
      email: event.data.email.toLowerCase(),
      name: user.nameEdited ? user.name : deriveName(event.data),
      avatarUrl: avatarUrl,
    });
    await claimInvitations(ctx, user._id, event.data);
  },
  "user.deleted": async (ctx, event): Promise<void> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", event.data.id))
      .first();
    if (!user) {
      console.warn(`User not found for deletion: ${event.data.id}`);

      return;
    }
    // WorkOS may redeliver a deletion: queue teardown once so a duplicate cannot race cleanup.
    if (user.workosDeletionRequestedAt) {
      return;
    }

    await ctx.db.patch(user._id, { workosDeletionRequestedAt: Date.now() });
    // The sign-in is already gone, so stop billing before core cleanup can fail.
    if (isManagedService()) {
      await ctx.scheduler.runAfter(
        0,
        internal.stripe.cancelUserSubscriptionsInternal,
        { authId: user.authId },
      );
    }
    await ctx.scheduler.runAfter(
      0,
      internal.org.workosUserDeletionCleanup.run,
      {
        authId: user.authId,
      },
    );
  },
  "session.created": async (): Promise<void> => {},
  "session.revoked": async (): Promise<void> => {},
});

export function deriveName(data: {
  firstName?: string | null;
  lastName?: string | null;
  email: string;
}): string {
  const first = data.firstName ?? "";
  const last = data.lastName ?? "";

  return `${first} ${last}`.trim() || data.email;
}

// An invitation sent before its email had an account becomes the user's once WorkOS has
// verified that they own the address.
async function claimInvitations(
  ctx: MutationCtx,
  userId: Id<"users">,
  data: { email: string; emailVerified?: boolean },
): Promise<void> {
  if (!data.emailVerified) return;
  const waiting = await ctx.db
    .query("orgInvitations")
    .withIndex("by_email_and_userId", (q) =>
      q.eq("email", data.email.toLowerCase()).eq("userId", undefined),
    )
    .collect();
  if (waiting.length === 0) return;
  for (const invitation of waiting) {
    await ctx.db.patch(invitation._id, { userId: userId });
  }
  await syncInvited(ctx, userId);
  await releaseSeat(ctx, ...waiting.map((invitation) => invitation.orgId));
}
