/**
 * One-time cutover from per-user to per-org billing. Each live subscription
 * still filed under a user and no org moves onto the org they own with the
 * most members (then the oldest), and every org they own gets its plan from
 * its own subscriptions, so the others drop to free. Run it once after the
 * deploy, dry first:
 * `npx convex run billingMigration:moveUserSubscriptionsToOrgs '{"dryRun":true}'`.
 * Delete this file once it has run on every deployment.
 */

import { v, type Infer } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import {
  isEnded,
  orgMemberCount,
  syncOrgPlan,
  syncUserPlan,
} from "./model/orgBilling";
import { stripeApi } from "./stripe";

const USERS_PER_PAGE = 50;

const moveValidator = v.object({
  authId: v.string(),
  stripeSubscriptionId: v.string(),
  orgId: v.id("orgs"),
});

const movePageValidator = v.object({
  authIds: v.array(v.string()),
  moves: v.array(moveValidator),
  continueCursor: v.string(),
  isDone: v.boolean(),
});

type Move = Infer<typeof moveValidator>;
type MovePage = Infer<typeof movePageValidator>;

/** Move every user-filed subscription onto an org. `dryRun` only lists the moves. */
export const moveUserSubscriptionsToOrgs = internalAction({
  args: { dryRun: v.boolean() },
  returns: v.array(moveValidator),
  handler: async (ctx, args): Promise<Array<Move>> => {
    const moved: Array<Move> = [];
    let cursor: string | null = null;
    for (;;) {
      const page: MovePage = await ctx.runQuery(
        internal.billingMigration.movePageInternal,
        { cursor: cursor },
      );
      if (!args.dryRun) {
        for (const move of page.moves) {
          // Stripe's copy first: the webhook reads it back on every change.
          await stripeApi().subscriptions.update(move.stripeSubscriptionId, {
            metadata: { userId: move.authId, orgId: move.orgId },
          });
        }
        await ctx.runMutation(internal.billingMigration.applyPageInternal, {
          authIds: page.authIds,
          moves: page.moves,
        });
      }
      moved.push(...page.moves);
      if (page.isDone) return moved;
      cursor = page.continueCursor;
    }
  },
});

/** One page of users, with each live subscription of theirs that no org holds and where it goes. */
export const movePageInternal = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: movePageValidator,
  handler: async (ctx, args): Promise<MovePage> => {
    const page = await ctx.db
      .query("users")
      .paginate({ cursor: args.cursor, numItems: USERS_PER_PAGE });
    const moves: Array<Move> = [];
    for (const user of page.page) {
      const subs = await ctx.runQuery(
        components.stripe.public.listSubscriptionsByUserId,
        { userId: user.authId },
      );
      const unfiled = subs.filter((sub) => !sub.orgId && !isEnded(sub.status));
      if (unfiled.length === 0) continue;
      const orgId = await targetOrg(ctx, user.authId);
      if (!orgId) {
        // Nothing to move it to; support cancels it by hand.
        console.warn(
          `User ${user.authId} pays ${unfiled.map((sub) => sub.stripeSubscriptionId).join(", ")} but owns no org`,
        );
        continue;
      }
      for (const sub of unfiled) {
        moves.push({
          authId: user.authId,
          stripeSubscriptionId: sub.stripeSubscriptionId,
          orgId: orgId,
        });
      }
    }

    return {
      authIds: page.page.map((user) => user.authId),
      moves: moves,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** File a page's moves under their orgs, then recompute each user's plan and every org they own. */
export const applyPageInternal = internalMutation({
  args: { authIds: v.array(v.string()), moves: v.array(moveValidator) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    for (const move of args.moves) {
      await ctx.runMutation(
        components.stripe.public.updateSubscriptionMetadata,
        {
          stripeSubscriptionId: move.stripeSubscriptionId,
          metadata: { userId: move.authId, orgId: move.orgId },
          orgId: move.orgId,
        },
      );
    }
    for (const authId of args.authIds) {
      await syncUserPlan(ctx, authId);
      const owned = await ctx.db
        .query("orgs")
        .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", authId))
        .collect();
      for (const org of owned) await syncOrgPlan(ctx, org._id);
    }

    return null;
  },
});

/** The org a user's subscription moves to: the one they own with the most members, then the oldest. */
async function targetOrg(
  ctx: QueryCtx,
  authId: string,
): Promise<Id<"orgs"> | null> {
  const owned = await ctx.db
    .query("orgs")
    .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", authId))
    .collect();
  const ranked = await Promise.all(
    owned.map(async (org) => ({
      org: org,
      members: await orgMemberCount(ctx, org._id),
    })),
  );
  ranked.sort(
    (left, right) =>
      right.members - left.members || left.org.createdAt - right.org.createdAt,
  );

  return ranked[0]?.org._id ?? null;
}
