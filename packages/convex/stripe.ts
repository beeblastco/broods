/**
 * Stripe billing per owner: checkout, seats and the portal for the user who
 * pays, and storing what Stripe returns. Each owner has one subscription,
 * filed under their authId: one `STRIPE_PRO_PRICE_ID` unit for Pro with its
 * included developer seats, plus one `STRIPE_SEAT_PRICE_ID` unit per extra
 * seat, shared by every org they own (model/orgBilling.ts). Its units are
 * the two lines added up. The webhook (http.ts) and the seat actions store a
 * subscription only as read back from Stripe, then recompute the plan of the
 * owner who pays and of every org they own.
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
  currentOf,
  developersOf,
  isEnded,
  isPaid,
  proQuantity,
  seatsForQuantity,
  seatsOf,
  syncUserPlan,
} from "./model/orgBilling";
import { getActiveOrgForUser, userByAuthId } from "./model/ownership/org";
import { planValidator } from "./schema";

export const stripeClient = new StripeSubscriptions(components.stripe);

const ownerBillingValidator = v.object({
  /** Distinct developers across every org the owner owns. */
  developers: v.number(),
  /** The owner's subscription billing acts on (`currentOf`), if any. */
  subscription: v.union(
    v.null(),
    v.object({
      stripeSubscriptionId: v.string(),
      status: v.string(),
    }),
  ),
});

type OwnerBilling = Infer<typeof ownerBillingValidator>;

/**
 * Start the checkout that puts the caller on Pro, for every org they own:
 * one unit, plus one for each developer past the included seats, kept from
 * before seats counted.
 */
export const createCheckoutSession = action({
  args: { successUrl: v.string(), cancelUrl: v.string() },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("Not authenticated");

    const billing = await ctx.runQuery(internal.stripe.ownerBillingInternal, {
      authId: authUser.id,
    });
    // Stops a second click or tab. It reads webhook-synced rows, so a checkout
    // paid seconds ago can still slip through.
    if (billing.subscription) {
      throw new ClientError(
        "Already subscribed; use Manage Billing to change plan",
        "conflict",
      );
    }

    const extraSeats = proQuantity(billing.developers) - 1;
    const session = await stripeClient.createCheckoutSession(ctx, {
      // The component requires one price; `line_items` below replaces its line.
      priceId: priceId("STRIPE_PRO_PRICE_ID"),
      customerId: await customerFor(ctx, authUser),
      mode: "subscription",
      successUrl: safeDashboardUrl(args.successUrl, "successUrl"),
      cancelUrl: safeDashboardUrl(args.cancelUrl, "cancelUrl"),
      // The component files a subscription under `metadata.userId`: who pays,
      // and whose orgs it covers.
      subscriptionMetadata: { userId: authUser.id },
      // Pro, then any extra seats on their own line. A promotion code made in
      // Stripe can discount it; Checkout still takes a card for later seats.
      params: {
        line_items: [
          { price: priceId("STRIPE_PRO_PRICE_ID"), quantity: 1 },
          ...(extraSeats > 0
            ? [{ price: priceId("STRIPE_SEAT_PRICE_ID"), quantity: extraSeats }]
            : []),
        ],
        allow_promotion_codes: true,
      },
    });

    if (!session.url) throw new Error("No checkout URL returned");

    return { url: session.url };
  },
});

/**
 * Make room for one more developer in the caller's seat pool: the units for
 * every developer plus one (`proQuantity`), one more than now when the pool
 * is full. Stripe invoices the prorated seat at once and refuses the change
 * if that payment fails, so the invite that follows only lands on a paid
 * seat. A seat already free charges nothing, so a second tab or a retried
 * invite never pays twice.
 * @returns the developer seats the caller now has
 */
export const addSeat = action({
  args: {},
  returns: v.object({ seats: v.number() }),
  handler: async (ctx): Promise<{ seats: number }> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("Not authenticated");

    const billing = await ctx.runQuery(internal.stripe.ownerBillingInternal, {
      authId: authUser.id,
    });
    if (!billing.subscription || !isPaid(billing.subscription.status)) {
      throw new ClientError(
        "Upgrade to Pro before adding seats",
        "payment_required",
      );
    }
    try {
      // Developers kept from before the owner paid get their seat too.
      const quantity = await changeSeats(
        ctx,
        billing.subscription.stripeSubscriptionId,
        (paid) => Math.max(paid, proQuantity(billing.developers + 1)),
        "always_invoice",
      );

      return { seats: seatsForQuantity(quantity) };
    } catch (error) {
      // Stripe answers 402 when the seat's payment fails: a declined card or
      // none on file.
      if (!(error instanceof Stripe.errors.StripeError)) throw error;
      if (error.statusCode !== 402) throw error;
      throw new ClientError(
        `The seat was not added: ${error.message} Add a card in Manage billing, then try again.`,
        "payment_required",
      );
    }
  },
});

/** The Stripe portal for the caller's own subscription. */
export const createPortalSession = action({
  args: { returnUrl: v.string() },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("Not authenticated");

    return await stripeClient.createCustomerPortalSession(ctx, {
      customerId: await customerFor(ctx, authUser),
      returnUrl: safeDashboardUrl(args.returnUrl, "returnUrl"),
    });
  },
});

/**
 * The plan behind the caller's active org. Its owner sees their whole pool:
 * their developer seats, how many are taken across their orgs, and their
 * subscription that has not ended (its status and period). Anyone else sees
 * only that subscription's status, which says whether the org runs on Pro
 * and whether their seat is paid; the owner's other orgs, developers and
 * billing period stay with the owner.
 */
export const getBillingInfo = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      kind: v.literal("owner"),
      seats: v.number(),
      developers: v.number(),
      subscription: v.union(
        v.null(),
        v.object({
          status: v.string(),
          currentPeriodEnd: v.number(),
          cancelAtPeriodEnd: v.boolean(),
        }),
      ),
    }),
    v.object({
      kind: v.literal("member"),
      status: v.union(v.null(), v.string()),
    }),
  ),
  handler: async (ctx) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) return null;
    const user = await userByAuthId(ctx, authUser.id);
    const org = user ? await getActiveOrgForUser(ctx, user._id) : null;
    if (!org) return null;

    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptionsByUserId,
      { userId: org.ownerAuthId },
    );
    // Any subscription that is not over, including past_due and unpaid ones,
    // so the dashboard offers the portal to fix payment instead of checkout.
    const live = currentOf(subs);
    if (org.ownerAuthId !== authUser.id) {
      return { kind: "member" as const, status: live?.status ?? null };
    }

    return {
      kind: "owner" as const,
      seats: seatsOf(subs),
      developers: (await developersOf(ctx, org.ownerAuthId)).size,
      subscription: live
        ? {
            status: live.status,
            currentPeriodEnd: live.currentPeriodEnd,
            cancelAtPeriodEnd: live.cancelAtPeriodEnd,
          }
        : null,
    };
  },
});

/** The developers on the caller's seats, each with the orgs of theirs they are in, for Billing. */
export const listSeatHolders = query({
  args: {},
  returns: v.array(
    v.object({
      userId: v.id("users"),
      name: v.string(),
      orgs: v.array(v.string()),
    }),
  ),
  handler: async (ctx) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }
    const developers = await developersOf(ctx, user.id);
    const rows = await Promise.all(
      [...developers].map(async ([userId, orgs]) => ({
        userId: userId,
        name: (await ctx.db.get(userId))?.name ?? "(unknown)",
        orgs: orgs.map((org) => org.name),
      })),
    );

    return rows.sort((left, right) => left.name.localeCompare(right.name));
  },
});

/** The orgs the caller owns, each with its plan, for Account settings. */
export const listOwnedOrgs = query({
  args: {},
  returns: v.array(
    v.object({
      orgId: v.id("orgs"),
      name: v.string(),
      plan: planValidator,
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

    return owned.map((org) => ({
      orgId: org._id,
      name: org.name,
      plan: org.plan,
    }));
  },
});

/** An owner's developers across their orgs and the subscription billing acts on. */
export const ownerBillingInternal = internalQuery({
  args: { authId: v.string() },
  returns: ownerBillingValidator,
  handler: async (ctx, args): Promise<OwnerBilling> => {
    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptionsByUserId,
      { userId: args.authId },
    );
    const live = currentOf(subs);

    return {
      developers: (await developersOf(ctx, args.authId)).size,
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
 * Lower an owner's units to what their developers need (`proQuantity`)
 * after one left their last org of the owner's, or an org was deleted,
 * whether or not the last payment went through. Stripe credits the unused
 * time on the next invoice. Units only go up on the owner's click
 * (`addSeat`). An owner with no live subscription, or one Stripe already
 * ended (a deleted owner's, canceled while this sync waited), is left alone.
 */
export const syncSeatsInternal = internalAction({
  args: { authId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const billing = await ctx.runQuery(internal.stripe.ownerBillingInternal, {
      authId: args.authId,
    });
    if (!billing.subscription) return null;
    await changeSeats(
      ctx,
      billing.subscription.stripeSubscriptionId,
      (paid) => Math.min(paid, proQuantity(billing.developers)),
      "create_prorations",
    );

    return null;
  },
});

/** Cancel a deleted user's subscriptions now, so they stop paying for Pro. */
export const cancelUserSubscriptionsInternal = internalAction({
  args: { authId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const subs = await ctx.runQuery(
      components.stripe.public.listSubscriptionsByUserId,
      { userId: args.authId },
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
 * user who pays and of every org they own. Webhook payloads are only a cue to
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
      quantity: unitsOf(live),
      priceId: item?.price.id ?? "",
      metadata: live.metadata,
    },
  });
}

/**
 * Set a subscription's units from what Stripe holds now, as one Pro line and
 * the rest on the seat line, and store the result: the read when nothing
 * changes, else the update under a ticket claimed once Stripe answered it, so
 * a webhook read that started before cannot land over the new units.
 * @returns the units the owner now pays for
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
  const paid = unitsOf(live);
  // An ended subscription takes no changes; store it as it is.
  const quantity = isEnded(live.status) ? paid : quantityFor(paid);
  if (quantity === paid) {
    await applyLive(ctx, ticket, live);

    return paid;
  }

  const updated = await stripe.subscriptions.update(subscriptionId, {
    items: itemsFor(live.items.data, quantity),
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

/**
 * The caller's Stripe customer while Stripe still has it: the one behind
 * their subscription billing acts on, else the one filed under them, else a
 * new one. A filed customer deleted in Stripe, or made under another secret
 * key, is unfiled first: the component keeps its row, and
 * `createOrUpdateCustomer` can only rename the row's userId, not clear it.
 */
async function customerFor(
  ctx: ActionCtx,
  authUser: { id: string; email?: string | null },
): Promise<string> {
  const stripe = stripeApi();
  const subs = await ctx.runQuery(
    components.stripe.public.listSubscriptionsByUserId,
    { userId: authUser.id },
  );
  const billed = currentOf(subs)?.stripeCustomerId;
  if (billed && (await stripeHasCustomer(stripe, billed))) return billed;
  let gone: string | null = null;
  let filed = await filedCustomer(ctx, authUser.id);
  while (filed) {
    if (await stripeHasCustomer(stripe, filed.stripeCustomerId)) {
      return filed.stripeCustomerId;
    }
    gone = filed.stripeCustomerId;
    await ctx.runMutation(components.stripe.public.createOrUpdateCustomer, {
      stripeCustomerId: gone,
      metadata: { userId: `unfiled:${authUser.id}` },
    });
    filed = await filedCustomer(ctx, authUser.id);
  }
  const { customerId } = await stripeClient.createCustomer(ctx, {
    email: authUser.email ?? undefined,
    metadata: { userId: authUser.id },
    // A double click makes one customer; replacing a gone one makes a new one.
    idempotencyKey: gone ? `${authUser.id}_after_${gone}` : authUser.id,
  });

  return customerId;
}

/** The customer the component files under a user, if any. */
async function filedCustomer(
  ctx: ActionCtx,
  userId: string,
): Promise<{ stripeCustomerId: string } | null> {
  return await ctx.runQuery(components.stripe.public.getCustomerByUserId, {
    userId: userId,
  });
}

/** The seat line change that makes a subscription's `lines` bill `units`: Pro is one, the rest are seats. */
function itemsFor(
  lines: Stripe.SubscriptionItem[],
  units: number,
): Stripe.SubscriptionUpdateParams.Item[] {
  const seat = priceId("STRIPE_SEAT_PRICE_ID");
  const seats = lines.find((line) => line.price.id === seat);
  const extra = units - 1;
  if (extra > 0) return [{ id: seats?.id, price: seat, quantity: extra }];

  return seats ? [{ id: seats.id, deleted: true }] : [];
}

/** The Stripe price an env var names: Pro, or one extra seat. */
function priceId(name: "STRIPE_PRO_PRICE_ID" | "STRIPE_SEAT_PRICE_ID"): string {
  const id = process.env[name];
  if (!id) throw new Error(`${name} is not configured`);

  return id;
}

/** Whether Stripe still has a customer under this deployment's secret key. */
async function stripeHasCustomer(
  stripe: Stripe,
  customerId: string,
): Promise<boolean> {
  try {
    return !(await stripe.customers.retrieve(customerId)).deleted;
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === "resource_missing"
    ) {
      return false;
    }
    throw error;
  }
}

/** The units a subscription bills: its Pro line and its seat line added up. */
function unitsOf(live: Stripe.Subscription): number {
  return live.items.data.reduce(
    (units, item) => units + (item.quantity ?? 1),
    0,
  );
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
