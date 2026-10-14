/**
 * Stripe billing per org: checkout, seats and the portal for the org owner,
 * and storing what Stripe returns. Each org has its own subscription to
 * `STRIPE_SEAT_PRICE_ID`: one unit for Pro with its included seats, one more
 * per extra member (model/orgBilling.ts). The
 * webhook (http.ts) and the seat actions store a subscription only as read
 * back from Stripe, then recompute the plan of the org it pays for and of the
 * owner who pays.
 */

import { StripeSubscriptions } from "@convex-dev/stripe";
import { v, type Infer } from "convex/values";
import Stripe from "stripe";
import { components, internal } from "./_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
} from "./_generated/server";
import { authKit } from "./auth";
import { ClientError } from "./model/clientError";
import {
  isEnded,
  isPaid,
  orgMemberCount,
  PRO_INCLUDED_DEVELOPER_SEATS,
  proQuantity,
  seatsOf,
  syncOrgPlan,
  syncUserPlan,
} from "./model/orgBilling";
import { getActiveOrgForUser, userByAuthId } from "./model/ownership/org";
import { planValidator } from "./schema";

export const stripeClient = new StripeSubscriptions(components.stripe);

const orgBillingValidator = v.object({
  orgId: v.id("orgs"),
  ownerAuthId: v.string(),
  members: v.number(),
  /** The org's subscription that has not ended, if any. */
  subscription: v.union(
    v.null(),
    v.object({
      stripeSubscriptionId: v.string(),
      status: v.string(),
    }),
  ),
});

type OrgBilling = Infer<typeof orgBillingValidator>;

/**
 * Start the checkout that puts the caller's active org on Pro: one unit, plus
 * one for each member past the included seats, kept from before seats
 * counted. Owner only.
 */
export const createCheckoutSession = action({
  args: { successUrl: v.string(), cancelUrl: v.string() },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("Not authenticated");

    const billing = await ownerBilling(ctx, authUser.id, {
      activeOf: authUser.id,
    });
    // Stops a second click or tab. It reads webhook-synced rows, so a checkout
    // paid seconds ago can still slip through. Stripe's "limit customers to one
    // subscription" setting must stay off: every org an owner pays for is one
    // more subscription on the same customer.
    if (billing.subscription) {
      throw new ClientError(
        "Already subscribed; use Manage Billing to change plan",
        "conflict",
      );
    }

    const { customerId } = await stripeClient.getOrCreateCustomer(ctx, {
      userId: authUser.id,
      email: authUser.email ?? undefined,
    });
    const session = await stripeClient.createCheckoutSession(ctx, {
      priceId: seatPriceId(),
      customerId: customerId,
      mode: "subscription",
      quantity: proQuantity(billing.members),
      successUrl: safeDashboardUrl(args.successUrl, "successUrl"),
      cancelUrl: safeDashboardUrl(args.cancelUrl, "cancelUrl"),
      // The component files a subscription under `metadata.userId` (who pays)
      // and `metadata.orgId` (what it pays for).
      subscriptionMetadata: { userId: authUser.id, orgId: billing.orgId },
    });

    if (!session.url) throw new Error("No checkout URL returned");

    return { url: session.url };
  },
});

/**
 * Make room for one more member in a paid org: the units for every member
 * plus one (`proQuantity`). Stripe invoices the prorated seat at once and
 * refuses the change if that payment fails, so the invite that follows only
 * lands on a paid seat. A seat already free charges nothing, so a second tab
 * or a retried invite never pays twice. Owner only.
 * @returns the seats the org now holds, included ones too
 */
export const addSeat = action({
  args: { orgId: v.id("orgs") },
  returns: v.object({ seats: v.number() }),
  handler: async (ctx, args): Promise<{ seats: number }> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("Not authenticated");

    const billing = await ownerBilling(ctx, authUser.id, { orgId: args.orgId });
    if (!billing.subscription || !isPaid(billing.subscription.status)) {
      throw new ClientError(
        "Upgrade this organization before adding seats",
        "payment_required",
      );
    }
    try {
      // Members kept from before the org paid get their seat too.
      const quantity = await changeSeats(
        ctx,
        billing.subscription.stripeSubscriptionId,
        (paid) => Math.max(paid, proQuantity(billing.members + 1)),
        "always_invoice",
      );

      return { seats: quantity + PRO_INCLUDED_DEVELOPER_SEATS };
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeCardError)) throw error;
      throw new ClientError(
        `The seat was not added: ${error.message}`,
        "payment_required",
      );
    }
  },
});

export const createPortalSession = action({
  args: { returnUrl: v.string() },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("Not authenticated");
    await ownerBilling(ctx, authUser.id, { activeOf: authUser.id });

    const { customerId } = await stripeClient.getOrCreateCustomer(ctx, {
      userId: authUser.id,
      email: authUser.email ?? undefined,
    });

    return await stripeClient.createCustomerPortalSession(ctx, {
      customerId: customerId,
      returnUrl: safeDashboardUrl(args.returnUrl, "returnUrl"),
    });
  },
});

/**
 * The caller's active org's subscription that has not ended, for any member:
 * its status, period and the seats invites count against. Who pays and the
 * Stripe ids stay with the owner.
 */
export const getBillingInfo = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      status: v.string(),
      currentPeriodEnd: v.number(),
      cancelAtPeriodEnd: v.boolean(),
      seats: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) return null;
    const user = await userByAuthId(ctx, authUser.id);
    const org = user ? await getActiveOrgForUser(ctx, user._id) : null;
    if (!org) return null;

    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptionsByOrgId,
      { orgId: org._id },
    );
    // Any subscription that is not over, including past_due and unpaid ones,
    // so the dashboard offers the portal to fix payment instead of checkout.
    const live = subs.find((sub) => !isEnded(sub.status));

    return live
      ? {
          status: live.status,
          currentPeriodEnd: live.currentPeriodEnd,
          cancelAtPeriodEnd: live.cancelAtPeriodEnd,
          seats: seatsOf(subs),
        }
      : null;
  },
});

/** The orgs the caller owns, each with its plan and seats, for Account settings. */
export const listOwnedOrgs = query({
  args: {},
  returns: v.array(
    v.object({
      orgId: v.id("orgs"),
      name: v.string(),
      plan: planValidator,
      seats: v.number(),
    }),
  ),
  handler: async (ctx) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const owned = await ctx.db
      .query("orgs")
      .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", user.id))
      .collect();

    return await Promise.all(
      owned.map(async (org) => ({
        orgId: org._id,
        name: org.name,
        plan: org.plan,
        seats: seatsOf(
          await ctx.runQuery(
            components.stripe.public.listSubscriptionsByOrgId,
            { orgId: org._id },
          ),
        ),
      })),
    );
  },
});

/** An org's owner, member count and live subscription: the named org, or `activeOf`'s active org. */
export const orgBillingInternal = internalQuery({
  args: {
    orgId: v.optional(v.id("orgs")),
    activeOf: v.optional(v.string()),
  },
  returns: v.union(v.null(), orgBillingValidator),
  handler: async (ctx, args): Promise<OrgBilling | null> => {
    const user = args.activeOf ? await userByAuthId(ctx, args.activeOf) : null;
    const org = args.orgId
      ? await ctx.db.get(args.orgId)
      : user && (await getActiveOrgForUser(ctx, user._id));
    if (!org) return null;

    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptionsByOrgId,
      { orgId: org._id },
    );
    const live = subs.find((sub) => !isEnded(sub.status));

    return {
      orgId: org._id,
      ownerAuthId: org.ownerAuthId,
      members: await orgMemberCount(ctx, org._id),
      subscription: live
        ? {
            stripeSubscriptionId: live.stripeSubscriptionId,
            status: live.status,
          }
        : null,
    };
  },
});

/**
 * Lower an org's units to what its members need (`proQuantity`) after someone
 * left, whether or not its last payment went through. Stripe credits the
 * unused time on the next invoice. Units only go up on the owner's click
 * (`addSeat`). A subscription bought at one unit per member, before Pro
 * included seats, drops to the same count here on its next run.
 */
export const syncSeatsInternal = internalAction({
  args: { orgId: v.id("orgs") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const billing = await ctx.runQuery(internal.stripe.orgBillingInternal, {
      orgId: args.orgId,
    });
    if (!billing?.subscription) return null;
    await changeSeats(
      ctx,
      billing.subscription.stripeSubscriptionId,
      (paid) => Math.min(paid, proQuantity(billing.members)),
      "create_prorations",
    );

    return null;
  },
});

/** Cancel a deleted org's subscriptions now, so its owner stops paying for it. */
export const cancelOrgSubscriptionsInternal = internalAction({
  args: { orgId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptionsByOrgId,
      { orgId: args.orgId },
    );
    for (const sub of subs.filter((sub) => !isEnded(sub.status))) {
      await stripeClient.cancelSubscription(ctx, {
        stripeSubscriptionId: sub.stripeSubscriptionId,
        cancelAtPeriodEnd: false,
      });
    }

    return null;
  },
});

/**
 * Take the next read ticket for a subscription. The webhook claims it before
 * it reads the subscription from Stripe, so ticket order is read start order.
 */
export const claimSubscriptionSyncInternal = internalMutation({
  args: { stripeSubscriptionId: v.string() },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const sync = await ctx.db
      .query("stripeSubscriptionSyncs")
      .withIndex("by_stripeSubscriptionId", (q) =>
        q.eq("stripeSubscriptionId", args.stripeSubscriptionId),
      )
      .unique();
    if (!sync) {
      await ctx.db.insert("stripeSubscriptionSyncs", {
        stripeSubscriptionId: args.stripeSubscriptionId,
        claimed: 1,
        applied: 0,
      });

      return 1;
    }
    await ctx.db.patch(sync._id, { claimed: sync.claimed + 1 });

    return sync.claimed + 1;
  },
});

/**
 * Store a subscription as Stripe returned it, then recompute the plan of the
 * org it pays for and of the user who pays. Webhook payloads are only a cue to
 * read: delivery is unordered and repeats, so the snapshot in an event can be
 * stale. A read is dropped when a read with a later ticket already landed,
 * and a subscription that ended never comes back, since Stripe never reopens
 * one.
 */
export const applySubscriptionInternal = internalMutation({
  args: {
    ticket: v.number(),
    subscription: v.object({
      stripeSubscriptionId: v.string(),
      stripeCustomerId: v.string(),
      status: v.string(),
      currentPeriodEnd: v.number(),
      cancelAtPeriodEnd: v.boolean(),
      cancelAt: v.optional(v.number()),
      quantity: v.number(),
      priceId: v.string(),
      metadata: v.record(v.string(), v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const sub = args.subscription;
    const sync = await ctx.db
      .query("stripeSubscriptionSyncs")
      .withIndex("by_stripeSubscriptionId", (q) =>
        q.eq("stripeSubscriptionId", sub.stripeSubscriptionId),
      )
      .unique();
    if (!sync || args.ticket <= sync.applied) return null;
    await ctx.db.patch(sync._id, { applied: args.ticket });

    const stored = await ctx.runQuery(
      components.stripe.public.getSubscription,
      { stripeSubscriptionId: sub.stripeSubscriptionId },
    );
    if (stored && isEnded(stored.status) && !isEnded(sub.status)) return null;

    // Created inserts a missing row and files earlier invoices under it;
    // updated then writes the current state over an existing one.
    await ctx.runMutation(
      components.stripe.private.handleSubscriptionCreated,
      sub,
    );
    await ctx.runMutation(
      components.stripe.private.handleSubscriptionUpdated,
      sub,
    );

    for (const authId of new Set([sub.metadata.userId, stored?.userId])) {
      if (authId) await syncUserPlan(ctx, authId);
    }
    for (const orgId of new Set([sub.metadata.orgId, stored?.orgId])) {
      if (orgId) await syncOrgPlan(ctx, orgId);
    }

    return null;
  },
});

/**
 * Read a subscription from Stripe and store that, never an event's snapshot:
 * a late or repeated event carries an old state. The ticket claimed before the
 * read keeps an older read from landing over a newer one.
 */
export async function reconcileSubscription(
  ctx: ActionCtx,
  stripe: Stripe,
  subscriptionId: string,
): Promise<void> {
  const ticket = await ctx.runMutation(
    internal.stripe.claimSubscriptionSyncInternal,
    { stripeSubscriptionId: subscriptionId },
  );
  await applyLive(
    ctx,
    ticket,
    await stripe.subscriptions.retrieve(subscriptionId),
  );
}

/** The Stripe API on this deployment's secret key. */
export function stripeApi(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");

  return new Stripe(secretKey);
}

/** The id of an expandable Stripe field, whether or not it was expanded. */
function stripeId(field: string | { id: string } | null): string | null {
  return typeof field === "string" ? field : (field?.id ?? null);
}

/** Store a subscription Stripe just returned, under a ticket claimed before the read. */
async function applyLive(
  ctx: ActionCtx,
  ticket: number,
  live: Stripe.Subscription,
): Promise<void> {
  const item = live.items.data[0];
  await ctx.runMutation(internal.stripe.applySubscriptionInternal, {
    ticket: ticket,
    subscription: {
      stripeSubscriptionId: live.id,
      stripeCustomerId: stripeId(live.customer) ?? "",
      status: live.status,
      currentPeriodEnd: item?.current_period_end ?? 0,
      cancelAtPeriodEnd: live.cancel_at_period_end,
      cancelAt: live.cancel_at ?? undefined,
      quantity: item?.quantity ?? 1,
      priceId: item?.price.id ?? "",
      metadata: live.metadata,
    },
  });
}

/**
 * Set a subscription's quantity from what Stripe holds now, on the seat price
 * (which also moves a migrated flat Pro item onto it), and store the result:
 * the read when nothing changes, else the update under a ticket claimed once
 * Stripe answered it, so a webhook read that started before cannot land over
 * the new quantity.
 * @returns the quantity the org now pays for
 */
async function changeSeats(
  ctx: ActionCtx,
  subscriptionId: string,
  quantityFor: (paid: number) => number,
  proration: "always_invoice" | "create_prorations",
): Promise<number> {
  const stripe = stripeApi();
  const ticket = await ctx.runMutation(
    internal.stripe.claimSubscriptionSyncInternal,
    { stripeSubscriptionId: subscriptionId },
  );
  const live = await stripe.subscriptions.retrieve(subscriptionId);
  const item = live.items.data[0];
  if (!item) throw new Error(`Subscription ${subscriptionId} has no items`);
  const paid = item.quantity ?? 1;
  const quantity = quantityFor(paid);
  if (quantity === paid) {
    await applyLive(ctx, ticket, live);

    return paid;
  }

  const updated = await stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price: seatPriceId(), quantity: quantity }],
    proration_behavior: proration,
    // A seat that needs a payment is added only once that payment succeeds.
    payment_behavior: "error_if_incomplete",
  });
  const updateTicket = await ctx.runMutation(
    internal.stripe.claimSubscriptionSyncInternal,
    { stripeSubscriptionId: subscriptionId },
  );
  await applyLive(ctx, updateTicket, updated);

  return quantity;
}

/** The org's billing when `authId` owns it; refuses anyone else. */
async function ownerBilling(
  ctx: ActionCtx,
  authId: string,
  org: { orgId: OrgBilling["orgId"] } | { activeOf: string },
): Promise<OrgBilling> {
  const billing = await ctx.runQuery(internal.stripe.orgBillingInternal, org);
  if (!billing || billing.ownerAuthId !== authId) {
    throw new ClientError(
      "Only the organization's owner can change its plan, seats or billing",
      "forbidden",
    );
  }

  return billing;
}

function seatPriceId(): string {
  const priceId = process.env.STRIPE_SEAT_PRICE_ID;
  if (!priceId) throw new Error("STRIPE_SEAT_PRICE_ID is not configured");

  return priceId;
}

/** The configured dashboard origin, or null when neither env var is set. */
function allowedDashboardOrigin(): string | null {
  const explicit = process.env.DASHBOARD_ORIGIN?.trim();
  if (explicit) return new URL(explicit).origin;

  const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (redirectUri) return new URL(redirectUri).origin;

  return null;
}

/** Validate Stripe return URLs so callers cannot choose arbitrary domains. */
function safeDashboardUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ClientError(`${label} must be a valid URL`);
  }

  const allowed = allowedDashboardOrigin();
  const isLocalDev =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (allowed ? url.origin !== allowed : !isLocalDev) {
    throw new ClientError(`${label} must use the configured dashboard origin`);
  }

  return url.toString();
}
