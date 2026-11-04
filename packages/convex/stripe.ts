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
  developers: v.number(),
  subscription: v.union(
    v.null(),
    v.object({
      stripeSubscriptionId: v.string(),
      status: v.string(),
    }),
  ),
});

type OwnerBilling = Infer<typeof ownerBillingValidator>;

export const createCheckoutSession = action({
  args: { successUrl: v.string(), cancelUrl: v.string() },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("Not authenticated");

    const billing = await ctx.runQuery(internal.stripe.ownerBillingInternal, {
      authId: authUser.id,
    });
    // Best effort: rows are webhook-synced, so a checkout paid seconds ago slips through.
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
      // The component files a subscription under `metadata.userId`: who pays.
      subscriptionMetadata: { userId: authUser.id },
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
      // Max, not +1: a free seat costs nothing, and developers from before Pro get theirs too.
      const quantity = await changeSeats(
        ctx,
        billing.subscription.stripeSubscriptionId,
        (paid) => Math.max(paid, proQuantity(billing.developers + 1)),
        "always_invoice",
      );

      return { seats: seatsForQuantity(quantity) };
    } catch (error) {
      // Stripe answers 402 for a declined card or none on file.
      if (!(error instanceof Stripe.errors.StripeError)) throw error;
      if (error.statusCode !== 402) throw error;
      throw new ClientError(
        `The seat was not added: ${error.message} Add a card in Manage billing, then try again.`,
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

    return await stripeClient.createCustomerPortalSession(ctx, {
      customerId: await customerFor(ctx, authUser),
      returnUrl: safeDashboardUrl(args.returnUrl, "returnUrl"),
    });
  },
});

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
    const live = currentOf(subs);
    // A member sees only the status; the owner's orgs, developers and period stay private.
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

// Claimed before the Stripe read, so ticket order is read start order.
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
    // Stripe never reopens an ended subscription, so a stale read must not revive it.
    if (stored && isEnded(stored.status) && !isEnded(sub.status)) return null;

    // Created inserts a missing row and files earlier invoices; updated overwrites the state.
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

// Store what Stripe returns, never an event's snapshot: a late or repeated event is stale.
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

export function stripeApi(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not configured");

  return new Stripe(secretKey);
}

function stripeId(field: string | { id: string } | null): string | null {
  return typeof field === "string" ? field : (field?.id ?? null);
}

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
  const quantity = isEnded(live.status) ? paid : quantityFor(paid);
  if (quantity === paid) {
    await applyLive(ctx, ticket, live);

    return paid;
  }

  const updated = await stripe.subscriptions.update(subscriptionId, {
    items: itemsFor(live.items.data, quantity),
    proration_behavior: proration,
    payment_behavior: "error_if_incomplete",
  });
  // Claimed after the update, so a webhook read that started earlier cannot land over it.
  const updateTicket = await ctx.runMutation(
    internal.stripe.claimSubscriptionSyncInternal,
    { stripeSubscriptionId: subscriptionId },
  );
  await applyLive(ctx, updateTicket, updated);

  return quantity;
}

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
  // A filed customer Stripe lost (deleted, other key) is unfiled by renaming its userId:
  // the component keeps the row and cannot clear it.
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

async function filedCustomer(
  ctx: ActionCtx,
  userId: string,
): Promise<{ stripeCustomerId: string } | null> {
  return await ctx.runQuery(components.stripe.public.getCustomerByUserId, {
    userId: userId,
  });
}

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

function priceId(name: "STRIPE_PRO_PRICE_ID" | "STRIPE_SEAT_PRICE_ID"): string {
  const id = process.env[name];
  if (!id) throw new Error(`${name} is not configured`);

  return id;
}

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

function unitsOf(live: Stripe.Subscription): number {
  return live.items.data.reduce(
    (units, item) => units + (item.quantity ?? 1),
    0,
  );
}

function allowedDashboardOrigin(): string | null {
  const explicit = process.env.DASHBOARD_ORIGIN?.trim();
  if (explicit) return new URL(explicit).origin;

  const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (redirectUri) return new URL(redirectUri).origin;

  return null;
}

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
