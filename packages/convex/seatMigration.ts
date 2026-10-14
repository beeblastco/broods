/**
 * One-time move of paid orgs onto Pro's included seats. A subscription bought
 * at one unit per member pays for more than `proQuantity` now asks, and
 * `stripe:syncSeatsInternal` only lowers it once a member leaves. This runs
 * that same sync for every org that pays too much, so the units drop now
 * (Stripe credits the difference on the next invoice). It never raises a
 * quantity, and a second run finds nothing to change. Run it once per
 * deployment after the deploy, dry first:
 * `npx convex run seatMigration:resyncAllSeats '{"dryRun":true}'`.
 * Delete this file once it has run on every deployment.
 */

import { v, type Infer } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalAction, internalQuery } from "./_generated/server";
import { isEnded, orgMemberCount, proQuantity } from "./model/orgBilling";

const ORGS_PER_PAGE = 50;

const resyncValidator = v.object({
  orgId: v.id("orgs"),
  oldQuantity: v.number(),
  newQuantity: v.number(),
});

const resyncPageValidator = v.object({
  resyncs: v.array(resyncValidator),
  continueCursor: v.string(),
  isDone: v.boolean(),
});

type Resync = Infer<typeof resyncValidator>;
type ResyncPage = Infer<typeof resyncPageValidator>;

/** Lower every org's units to what its members need. `dryRun` only lists the changes. */
export const resyncAllSeats = internalAction({
  args: { dryRun: v.boolean() },
  returns: v.array(resyncValidator),
  handler: async (ctx, args): Promise<Array<Resync>> => {
    const resynced: Array<Resync> = [];
    let cursor: string | null = null;
    for (;;) {
      const page: ResyncPage = await ctx.runQuery(
        internal.seatMigration.resyncPageInternal,
        { cursor: cursor },
      );
      if (!args.dryRun) {
        for (const resync of page.resyncs) {
          await ctx.runAction(internal.stripe.syncSeatsInternal, {
            orgId: resync.orgId,
          });
        }
      }
      resynced.push(...page.resyncs);
      if (page.isDone) return resynced;
      cursor = page.continueCursor;
    }
  },
});

/** One page of orgs, with each one whose live subscription pays for more units than its members need. */
export const resyncPageInternal = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: resyncPageValidator,
  handler: async (ctx, args): Promise<ResyncPage> => {
    const page = await ctx.db
      .query("orgs")
      .paginate({ cursor: args.cursor, numItems: ORGS_PER_PAGE });
    const resyncs: Array<Resync> = [];
    for (const org of page.page) {
      const subs = await ctx.runQuery(
        components.stripe.public.listSubscriptionsByOrgId,
        { orgId: org._id },
      );
      const live = subs.find((sub) => !isEnded(sub.status));
      if (!live) continue;
      const oldQuantity = live.quantity ?? 1;
      const newQuantity = Math.min(
        oldQuantity,
        proQuantity(await orgMemberCount(ctx, org._id)),
      );
      if (newQuantity === oldQuantity) continue;
      resyncs.push({
        orgId: org._id,
        oldQuantity: oldQuantity,
        newQuantity: newQuantity,
      });
    }

    return {
      resyncs: resyncs,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});
