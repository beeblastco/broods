/**
 * One-time move of paying owners onto the seat pool. Pro now belongs to the
 * owner and covers every org they own, so each owner keeps one subscription:
 * its units drop to what their developers need (`proQuantity`), counted once
 * across their orgs, and every org they own takes their plan. This runs the
 * same seat sync and plan sync the webhook runs, for every owner with a
 * subscription (Stripe credits the units it drops on the next invoice). It
 * never raises a quantity and never cancels anything: an owner who pays for
 * more than one subscription keeps the one with the most units (the oldest
 * on a tie), and the other paid ones are listed under `duplicates` for
 * someone to refund and cancel by hand. An owner
 * Stripe refuses is reported and the run carries on, so running it again
 * retries only those. Run it once per deployment after the deploy, dry
 * first: `npx convex run seatMigration:resyncAllSeats '{"dryRun":true}'`.
 * Delete this file once it has run on every deployment.
 */

import { v, type Infer } from "convex/values";
import { components, internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import {
  developersOf,
  currentOf,
  isPaid,
  proQuantity,
  syncUserPlan,
} from "./model/orgBilling";

const USERS_PER_PAGE = 50;

const resyncValidator = v.object({
  authId: v.string(),
  stripeSubscriptionId: v.string(),
  oldQuantity: v.number(),
  newQuantity: v.number(),
});

const duplicateValidator = v.object({
  authId: v.string(),
  stripeSubscriptionId: v.string(),
});

const resyncPageValidator = v.object({
  resyncs: v.array(resyncValidator),
  duplicates: v.array(duplicateValidator),
  continueCursor: v.string(),
  isDone: v.boolean(),
});

const resyncResultValidator = v.object({
  done: v.array(resyncValidator),
  failed: v.array(v.object({ authId: v.string(), error: v.string() })),
  duplicates: v.array(duplicateValidator),
});

type Resync = Infer<typeof resyncValidator>;
type Duplicate = Infer<typeof duplicateValidator>;
type ResyncPage = Infer<typeof resyncPageValidator>;
type ResyncResult = Infer<typeof resyncResultValidator>;

/**
 * Put every owner with a subscription on the pool: their units, and the plan
 * of every org they own. Reports the owners whose units it changed, the ones
 * that failed, and each owner's paid subscriptions past the one kept. `dryRun`
 * only lists them.
 */
export const resyncAllSeats = internalAction({
  args: { dryRun: v.boolean() },
  returns: resyncResultValidator,
  handler: async (ctx, args): Promise<ResyncResult> => {
    const result: ResyncResult = { done: [], failed: [], duplicates: [] };
    let cursor: string | null = null;
    for (;;) {
      const page: ResyncPage = await ctx.runQuery(
        internal.seatMigration.resyncPageInternal,
        { cursor: cursor },
      );
      result.duplicates.push(...page.duplicates);
      for (const resync of page.resyncs) {
        try {
          if (!args.dryRun) {
            await ctx.runMutation(internal.seatMigration.syncPlanInternal, {
              authId: resync.authId,
            });
            if (resync.newQuantity < resync.oldQuantity) {
              await ctx.runAction(internal.stripe.syncSeatsInternal, {
                authId: resync.authId,
              });
            }
          }
          if (resync.newQuantity < resync.oldQuantity) result.done.push(resync);
        } catch (error) {
          result.failed.push({
            authId: resync.authId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (page.isDone) return result;
      cursor = page.continueCursor;
    }
  },
});

/**
 * One page of users: each one with a subscription that has not ended, with
 * the units it pays for and the units their developers need, and every
 * other paid subscription of theirs.
 */
export const resyncPageInternal = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: resyncPageValidator,
  handler: async (ctx, args): Promise<ResyncPage> => {
    const page = await ctx.db
      .query("users")
      .paginate({ cursor: args.cursor, numItems: USERS_PER_PAGE });
    const resyncs: Array<Resync> = [];
    const duplicates: Array<Duplicate> = [];
    for (const user of page.page) {
      const subs = await ctx.runQuery(
        components.stripe.public.listSubscriptionsByUserId,
        { userId: user.authId },
      );
      const current = currentOf(subs);
      if (!current) continue;
      for (const sub of subs) {
        if (sub === current || !isPaid(sub.status)) continue;
        duplicates.push({
          authId: user.authId,
          stripeSubscriptionId: sub.stripeSubscriptionId,
        });
      }
      const oldQuantity = current.quantity ?? 1;
      resyncs.push({
        authId: user.authId,
        stripeSubscriptionId: current.stripeSubscriptionId,
        oldQuantity: oldQuantity,
        newQuantity: Math.min(
          oldQuantity,
          proQuantity((await developersOf(ctx, user.authId)).size),
        ),
      });
    }

    return {
      resyncs: resyncs,
      duplicates: duplicates,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Put an owner, and every org they own, on the plan their subscriptions grant. */
export const syncPlanInternal = internalMutation({
  args: { authId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await syncUserPlan(ctx, args.authId);

    return null;
  },
});
