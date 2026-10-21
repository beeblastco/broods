/// <reference types="vite/client" />
import { createHash } from "node:crypto";
import { convexTest, type TestConvex } from "convex-test";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
// The package exports no schema or test helper, so load the component's own
// build straight from disk to register it.
import stripeSchema from "../node_modules/@convex-dev/stripe/dist/component/schema.js";
import schema from "../schema";
import { currentOf, proQuantity, seatsForQuantity } from "../model/orgBilling";
import { PLAN_LIMITS } from "../model/planLimits";
import { stripeClient } from "../stripe";

const AUTH_ID = "auth_payer";
const CUSTOMER_ID = "cus_payer";
const SUBSCRIPTION_ID = "sub_payer";
const ITEM_ID = "si_payer";
const PRO_ITEM_ID = "si_payer_pro";
const WEBHOOK_SECRET = "whsec_billing_test";

const stripeCalls = vi.hoisted(() => ({
  customers: vi.fn(),
  retrieveCustomer: vi.fn(),
  // What Stripe holds now, by subscription id. The webhook reads it back.
  live: new Map<string, Record<string, unknown>>(),
  retrieveSubscription: vi.fn(),
  subscriptions: vi.fn(),
}));

// Who is signed in.
const caller = vi.hoisted(() => ({ authId: "auth_payer" }));

// The org `seedPayer` made for the payer.
let payerOrgId: Id<"orgs">;

vi.mock("../auth", () => ({
  authKit: {
    getAuthUser: async () => ({
      id: caller.authId,
      email: caller.authId === AUTH_ID ? "payer@example.com" : null,
    }),
    registerRoutes: () => undefined,
  },
}));

// Real Stripe for signing and verifying events; the calls the webhook makes are
// stubbed so no test reaches the Stripe API. This covers our modules only:
// @convex-dev/stripe loads its own copy, so tests spy on `stripeClient`.
vi.mock("stripe", async (importOriginal) => {
  const { default: RealStripe } =
    await importOriginal<typeof import("stripe")>();
  class TestStripe extends RealStripe {
    constructor(key: string) {
      super(key);
      this.customers.update = stripeCalls.customers;
      this.customers.retrieve = stripeCalls.retrieveCustomer;
      this.subscriptions.retrieve = stripeCalls.retrieveSubscription;
      this.subscriptions.update = stripeCalls.subscriptions;
    }
  }

  return { default: TestStripe };
});

const modules = import.meta.glob("../**/*.ts");
const stripeModules = import.meta.glob(
  "../node_modules/@convex-dev/stripe/dist/component/**/*.js",
);

type T = TestConvex<typeof schema>;

describe("stripe webhook plan sync", () => {
  test("a created subscription upgrades the user and the orgs they own", async () => {
    const t = billingTest();
    await seedPayer(t);

    await sendEvent(t, "customer.subscription.created", subscription("active"));

    expect(await plans(t)).toEqual({ user: "pro", org: "pro" });
  });

  test("a deleted subscription drops the user back to free", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));

    await sendEvent(
      t,
      "customer.subscription.deleted",
      subscription("canceled"),
    );

    expect(await plans(t)).toEqual({ user: "free", org: "free" });
  });

  test.each<[Stripe.Subscription.Status, string]>([
    ["trialing", "pro"],
    ["active", "pro"],
    ["past_due", "free"],
    ["paused", "free"],
    ["canceled", "free"],
    ["incomplete", "free"],
    ["incomplete_expired", "free"],
    ["unpaid", "free"],
  ])("a %s subscription means the %s plan", async (status, plan) => {
    const t = billingTest();
    await seedPayer(t);

    await sendEvent(t, "customer.subscription.updated", subscription(status));

    expect(await plans(t)).toEqual({ user: plan, org: plan });
  });
});

// Stripe delivers events out of order and more than once, so the webhook reads
// the subscription back from Stripe instead of trusting the event's snapshot.
describe("stripe webhook ordering", () => {
  test("a delayed older update cannot restore Pro after cancellation", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    await sendEvent(
      t,
      "customer.subscription.deleted",
      subscription("canceled"),
    );

    const late = await deliver(
      t,
      "evt_old_update",
      "customer.subscription.updated",
      subscription("active"),
    );

    expect(late.status).toBe(200);
    expect(await plans(t)).toEqual({ user: "free", org: "free" });
    const subs = await t.query(
      components.stripe.public.listSubscriptionsByUserId,
      { userId: AUTH_ID },
    );
    expect(subs.map((sub) => sub.status)).toEqual(["canceled"]);
  });

  test("a redelivered event reads Stripe again and cannot restore Pro", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    await sendEvent(t, "customer.subscription.updated", subscription("active"));
    await sendEvent(
      t,
      "customer.subscription.deleted",
      subscription("canceled"),
    );
    stripeCalls.retrieveSubscription.mockClear();

    const again = await deliver(
      t,
      "evt_customer.subscription.updated",
      "customer.subscription.updated",
      subscription("active"),
    );

    expect(again.status).toBe(200);
    expect(stripeCalls.retrieveSubscription).toHaveBeenCalledWith(
      SUBSCRIPTION_ID,
    );
    expect(await plans(t)).toEqual({ user: "free", org: "free" });
  });

  test("a redelivered checkout cannot restore Pro after cancellation", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "checkout.session.completed", checkout(AUTH_ID));
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    await sendEvent(
      t,
      "customer.subscription.deleted",
      subscription("canceled"),
    );

    const again = await deliver(
      t,
      "evt_checkout.session.completed",
      "checkout.session.completed",
      checkout(AUTH_ID),
    );

    expect(again.status).toBe(200);
    expect(await plans(t)).toEqual({ user: "free", org: "free" });
  });

  test("events with the same timestamp follow Stripe's current state", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    stripeCalls.live.set(SUBSCRIPTION_ID, subscription("canceled"));

    // Neither payload carries a `created`, so they tie; the order they arrive
    // in does not decide the plan.
    await deliver(
      t,
      "evt_deleted",
      "customer.subscription.deleted",
      subscription("canceled"),
    );
    await deliver(
      t,
      "evt_updated",
      "customer.subscription.updated",
      subscription("active"),
    );

    expect(await plans(t)).toEqual({ user: "free", org: "free" });
  });

  test("a failed read returns 500 and the retry applies it", async () => {
    const t = billingTest();
    await seedPayer(t);
    stripeCalls.live.set(SUBSCRIPTION_ID, subscription("active"));
    stripeCalls.retrieveSubscription.mockRejectedValueOnce(
      new Error("Stripe unavailable"),
    );

    const failed = await deliver(
      t,
      "evt_created",
      "customer.subscription.created",
      subscription("active"),
    );
    expect(failed.status).toBe(500);
    expect(await plans(t)).toEqual({ user: "free", org: "free" });

    const retried = await deliver(
      t,
      "evt_created",
      "customer.subscription.created",
      subscription("active"),
    );
    expect(retried.status).toBe(200);
    expect(await plans(t)).toEqual({ user: "pro", org: "pro" });
  });

  test("concurrent deliveries cannot land an older read over a newer one", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    const first = Promise.withResolvers<Record<string, unknown>>();
    const second = Promise.withResolvers<Record<string, unknown>>();
    stripeCalls.retrieveSubscription
      .mockClear()
      .mockImplementationOnce(async () => await first.promise)
      .mockImplementationOnce(async () => await second.promise);

    const early = deliver(
      t,
      "evt_early",
      "customer.subscription.updated",
      subscription("active"),
    );
    await vi.waitFor(() =>
      expect(stripeCalls.retrieveSubscription).toHaveBeenCalledTimes(1),
    );
    const later = deliver(
      t,
      "evt_later",
      "customer.subscription.deleted",
      subscription("canceled"),
    );
    await vi.waitFor(() =>
      expect(stripeCalls.retrieveSubscription).toHaveBeenCalledTimes(2),
    );
    // The later read lands first; the earlier read, still active, lands last.
    second.resolve(subscription("canceled"));
    expect((await later).status).toBe(200);
    first.resolve(subscription("active"));
    expect((await early).status).toBe(200);

    expect(await plans(t)).toEqual({ user: "free", org: "free" });
  });

  test("a read that started later but saw an older state cannot reopen a canceled subscription", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    const first = Promise.withResolvers<Record<string, unknown>>();
    const second = Promise.withResolvers<Record<string, unknown>>();
    stripeCalls.retrieveSubscription
      .mockClear()
      .mockImplementationOnce(async () => await first.promise)
      .mockImplementationOnce(async () => await second.promise);

    const deleted = deliver(
      t,
      "evt_deleted",
      "customer.subscription.deleted",
      subscription("canceled"),
    );
    await vi.waitFor(() =>
      expect(stripeCalls.retrieveSubscription).toHaveBeenCalledTimes(1),
    );
    const updated = deliver(
      t,
      "evt_updated",
      "customer.subscription.updated",
      subscription("active"),
    );
    await vi.waitFor(() =>
      expect(stripeCalls.retrieveSubscription).toHaveBeenCalledTimes(2),
    );
    first.resolve(subscription("canceled"));
    expect((await deleted).status).toBe(200);
    second.resolve(subscription("active"));
    expect((await updated).status).toBe(200);

    expect(await plans(t)).toEqual({ user: "free", org: "free" });
  });

  test("a failed payment drops to free until Stripe reports it paid", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    await sendEvent(
      t,
      "customer.subscription.updated",
      subscription("past_due"),
      "evt_payment_failed",
    );
    expect(await plans(t)).toEqual({ user: "free", org: "free" });

    await deliver(
      t,
      "evt_old_active",
      "customer.subscription.updated",
      subscription("active"),
    );
    expect(await plans(t)).toEqual({ user: "free", org: "free" });

    await sendEvent(
      t,
      "customer.subscription.updated",
      subscription("active"),
      "evt_payment_recovered",
    );
    expect(await plans(t)).toEqual({ user: "pro", org: "pro" });
  });

  test("a new subscription after cancellation grants Pro and the old one stays canceled", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    await sendEvent(
      t,
      "customer.subscription.deleted",
      subscription("canceled"),
    );

    await sendEvent(
      t,
      "customer.subscription.created",
      subscription("active", "sub_again"),
      "evt_resubscribed",
    );
    await deliver(
      t,
      "evt_old_update",
      "customer.subscription.updated",
      subscription("active"),
    );

    expect(await plans(t)).toEqual({ user: "pro", org: "pro" });
    const subs = await t.query(
      components.stripe.public.listSubscriptionsByUserId,
      { userId: AUTH_ID },
    );
    expect(
      Object.fromEntries(
        subs.map((sub) => [sub.stripeSubscriptionId, sub.status]),
      ),
    ).toEqual({ [SUBSCRIPTION_ID]: "canceled", sub_again: "active" });
  });

  test("an invalid signature is refused and grants nothing", async () => {
    const t = billingTest();
    await seedPayer(t);

    const response = await t.fetch("/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "invalid" },
      body: JSON.stringify({
        id: "evt_forged",
        type: "customer.subscription.updated",
        data: { object: subscription("active") },
      }),
    });

    expect(response.status).toBe(400);
    expect(await plans(t)).toEqual({ user: "free", org: "free" });
  });
});

// Pro belongs to the owner: one subscription, filed under them, puts every
// org they own on Pro. Only they start it, change its seats or open its portal.
describe("owner billing", () => {
  test("a subscription puts every org the owner owns on Pro, and cancelling frees them all", async () => {
    const t = billingTest();
    await seedPayer(t);
    const second = await seedOrg(t, "Second");
    const third = await seedOrg(t, "Third");

    await sendEvent(t, "customer.subscription.created", subscription("active"));
    expect(await plans(t)).toEqual({ user: "pro", org: "pro" });
    expect([await orgPlan(t, second), await orgPlan(t, third)]).toEqual([
      "pro",
      "pro",
    ]);

    await sendEvent(
      t,
      "customer.subscription.deleted",
      subscription("canceled"),
    );
    expect(await plans(t)).toEqual({ user: "free", org: "free" });
    expect([await orgPlan(t, second), await orgPlan(t, third)]).toEqual([
      "free",
      "free",
    ]);
  });

  test("a subscription changes no other owner's orgs", async () => {
    const t = billingTest();
    await seedPayer(t);
    await seedUser(t, "auth_other", "other@example.com");
    const other = await seedOrg(t, "Other", "auth_other");

    await sendEvent(t, "customer.subscription.created", subscription("active"));

    expect(await orgPlan(t, other)).toBe("free");
  });

  test.each([
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 3],
  ])(
    "Pro for %i developers is %i units: 2 developer seats included, then one per extra seat",
    (developers, units) => {
      expect(proQuantity(developers)).toBe(units);
    },
  );

  test("checkout bills the owner one Pro unit, filed under them, while the included seats cover every developer", async () => {
    const t = billingTest();
    await seedPayer(t);
    await addMember(t, "auth_member", "member@example.com");
    const customer = vi
      .spyOn(stripeClient, "createCustomer")
      .mockResolvedValue({ customerId: CUSTOMER_ID });
    const checkoutSession = vi
      .spyOn(stripeClient, "createCheckoutSession")
      .mockResolvedValue({ sessionId: "cs_pro", url: "https://checkout.test" });

    const { url } = await t.action(api.stripe.createCheckoutSession, {
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/cancel",
    });

    expect(url).toBe("https://checkout.test");
    expect(customer).toHaveBeenCalledWith(expect.anything(), {
      email: "payer@example.com",
      metadata: { userId: AUTH_ID },
      idempotencyKey: AUTH_ID,
    });
    expect(checkoutSession).toHaveBeenCalledWith(expect.anything(), {
      priceId: "price_pro",
      customerId: CUSTOMER_ID,
      mode: "subscription",
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/cancel",
      subscriptionMetadata: { userId: AUTH_ID },
      params: {
        line_items: [{ price: "price_pro", quantity: 1 }],
        allow_promotion_codes: true,
        payment_method_collection: "if_required",
      },
    });
  });

  test("upgrading an owner who kept 4 developers across 2 orgs bills Pro plus 2 extra seats", async () => {
    const t = billingTest();
    await seedPayer(t);
    const second = await seedOrg(t, "Second");
    await addMember(t, "auth_kept_a", "a@example.com");
    await addMember(t, "auth_kept_b", "b@example.com");
    await addMember(t, "auth_kept_a", "a@example.com", second);
    await addMember(t, "auth_kept_c", "c@example.com", second);
    await addMember(t, "auth_kept_d", "d@example.com", second);
    vi.spyOn(stripeClient, "createCustomer").mockResolvedValue({
      customerId: CUSTOMER_ID,
    });
    const checkoutSession = vi
      .spyOn(stripeClient, "createCheckoutSession")
      .mockResolvedValue({ sessionId: "cs_pro", url: "https://checkout.test" });

    await t.action(api.stripe.createCheckoutSession, {
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/cancel",
    });

    expect(checkoutSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        params: expect.objectContaining({
          line_items: [
            { price: "price_pro", quantity: 1 },
            { price: "price_seat", quantity: 2 },
          ],
        }),
      }),
    );
  });

  test("checkout replaces a filed customer Stripe no longer has", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.created", {
      id: "cus_gone",
      object: "customer",
      email: "payer@example.com",
      metadata: { userId: AUTH_ID },
    });
    stripeCalls.retrieveCustomer.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        message: "No such customer: 'cus_gone'",
        type: "invalid_request_error",
        code: "resource_missing",
      }),
    );
    const customer = vi
      .spyOn(stripeClient, "createCustomer")
      .mockResolvedValue({ customerId: CUSTOMER_ID });
    const checkoutSession = vi
      .spyOn(stripeClient, "createCheckoutSession")
      .mockResolvedValue({ sessionId: "cs_pro", url: "https://checkout.test" });

    await t.action(api.stripe.createCheckoutSession, {
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/cancel",
    });

    expect(customer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: `${AUTH_ID}_after_cus_gone` }),
    );
    expect(checkoutSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerId: CUSTOMER_ID }),
    );
    expect(
      await t.query(components.stripe.public.getCustomerByUserId, {
        userId: AUTH_ID,
      }),
    ).toBeNull();
  });

  test("refuses a second checkout while the owner has a live subscription", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("paused"));

    await expect(
      t.action(api.stripe.createCheckoutSession, {
        successUrl: "http://localhost:3000/ok",
        cancelUrl: "http://localhost:3000/cancel",
      }),
    ).rejects.toThrow("Already subscribed");
  });

  test("a paused subscription opens the owner's portal", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.created", {
      id: CUSTOMER_ID,
      object: "customer",
      email: "payer@example.com",
      metadata: { userId: AUTH_ID },
    });
    await sendEvent(t, "customer.subscription.updated", subscription("paused"));
    const portalSession = vi
      .spyOn(stripeClient, "createCustomerPortalSession")
      .mockResolvedValue({ url: "https://portal.test" });

    const portal = await t.action(api.stripe.createPortalSession, {
      returnUrl: "http://localhost:3000/billing",
    });

    expect(portal.url).toBe("https://portal.test");
    expect(portalSession).toHaveBeenCalledWith(expect.anything(), {
      customerId: CUSTOMER_ID,
      returnUrl: "http://localhost:3000/billing",
    });
    expect(await plans(t)).toEqual({ user: "free", org: "free" });
  });

  test("the portal opens on the customer behind the owner's subscription, even with no customer filed for them", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(
      t,
      "customer.subscription.updated",
      subscription("past_due"),
    );
    const customer = vi
      .spyOn(stripeClient, "createCustomer")
      .mockResolvedValue({ customerId: "cus_new" });
    const portalSession = vi
      .spyOn(stripeClient, "createCustomerPortalSession")
      .mockResolvedValue({ url: "https://portal.test" });

    await t.action(api.stripe.createPortalSession, {
      returnUrl: "http://localhost:3000/billing",
    });

    expect(customer).not.toHaveBeenCalled();
    expect(portalSession).toHaveBeenCalledWith(expect.anything(), {
      customerId: CUSTOMER_ID,
      returnUrl: "http://localhost:3000/billing",
    });
  });

  test("getBillingInfo shows a member the owner's subscription", async () => {
    const t = billingTest();
    await seedPayer(t);
    await addMember(t, "auth_member", "member@example.com");
    await sendEvent(
      t,
      "customer.subscription.created",
      subscription("past_due"),
    );
    caller.authId = "auth_member";

    const info = await t.query(api.stripe.getBillingInfo, {});

    // Only the status: the owner's pool and billing period stay with them.
    expect(info).toEqual({ kind: "member", status: "past_due" });
  });

  test("getBillingInfo shows no subscription once it is canceled", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    await sendEvent(
      t,
      "customer.subscription.deleted",
      subscription("canceled"),
    );

    expect(await t.query(api.stripe.getBillingInfo, {})).toEqual({
      kind: "owner",
      seats: 0,
      developers: 0,
      subscription: null,
    });
  });

  test("an owner paying for two subscriptions is billed from the one with the most units, the oldest on a tie", async () => {
    const t = billingTest();
    await seedPayer(t);
    const second = await seedOrg(t, "Second");
    await addMember(t, "auth_dev_a", "a@example.com");
    await addMember(t, "auth_dev_b", "b@example.com");
    await addMember(t, "auth_dev_c", "c@example.com", second);
    // Per-org billing left a 1-unit subscription, the oldest, and a 4-unit one.
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    await sendEvent(
      t,
      "customer.subscription.created",
      subscription("active", "sub_big", 4),
      "evt_big",
    );

    expect(await t.query(api.stripe.getBillingInfo, {})).toMatchObject({
      seats: seatsForQuantity(4),
      developers: 3,
    });
    expect(
      currentOf([
        { id: "older", status: "active", quantity: 2 },
        { id: "newer", status: "active", quantity: 2 },
      ])?.id,
    ).toBe("older");
  });

  test("deleting an org keeps the owner on Pro and gives back the seats only it used", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedIncludedSeatsTaken(t, 2);
    const second = await seedOrg(t, "Second");
    await addMember(t, "auth_dev_three", "dev-three@example.com", second);
    stripeCalls.subscriptions.mockImplementation(updateLive);
    const cancel = vi.spyOn(stripeClient, "cancelSubscription");

    vi.useFakeTimers();
    await t.mutation(api.org.orgs.remove, { orgId: second });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(cancel).not.toHaveBeenCalled();
    expect(stripeCalls.subscriptions).toHaveBeenCalledWith(SUBSCRIPTION_ID, {
      items: [{ id: ITEM_ID, deleted: true }],
      proration_behavior: "create_prorations",
      payment_behavior: "error_if_incomplete",
    });
    expect(await plans(t)).toEqual({ user: "pro", org: "pro" });
  });

  test("deleting the owner's account cancels their subscription", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    const cancel = vi
      .spyOn(stripeClient, "cancelSubscription")
      .mockResolvedValue(null);

    vi.useFakeTimers();
    await t.mutation(internal.org.workosUserDeletion.finalize, {
      authId: AUTH_ID,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(cancel).toHaveBeenCalledWith(expect.anything(), {
      stripeSubscriptionId: SUBSCRIPTION_ID,
      cancelAtPeriodEnd: false,
    });
  });
});

// Pro gives the owner 2 developer seats, a pool across every org they own:
// each developer takes one, however many of those orgs they are in. The owner
// pays for each seat past those before the developer it is for can join.
describe("seat pool", () => {
  test("a Hobby owner has no developer seats, so their invite is refused", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await seedUser(t, "auth_new", "new@example.com");

    await expect(
      t.mutation(api.org.members.add, {
        orgId: payerOrgId,
        email: "new@example.com",
      }),
    ).rejects.toThrow(
      "Payer Org's owner is on Hobby, which has no developer seats",
    );
    expect(await memberCount(t)).toBe(1);
  });

  test("an owner whose payment is due cannot invite, and is told to fix the payment", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await seedUser(t, "auth_new", "new@example.com");
    await sendEvent(
      t,
      "customer.subscription.created",
      subscription("past_due"),
    );

    await expect(
      t.mutation(api.org.members.add, {
        orgId: payerOrgId,
        email: "new@example.com",
      }),
    ).rejects.toThrow("Payment for Payer Org's owner's Pro plan is due");
    expect(await memberCount(t)).toBe(1);
  });

  test("Pro invites 2 developers, then the next one needs a seat", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    for (const name of ["second", "third", "fourth"]) {
      await seedUser(t, `auth_${name}`, `${name}@example.com`);
    }
    await sendEvent(t, "customer.subscription.created", subscription("active"));

    for (const name of ["second", "third"]) {
      await t.mutation(api.org.members.add, {
        orgId: payerOrgId,
        email: `${name}@example.com`,
      });
    }
    await expect(
      t.mutation(api.org.members.add, {
        orgId: payerOrgId,
        email: "fourth@example.com",
      }),
    ).rejects.toThrow("Every developer seat is taken. Add a seat in Billing.");
    stripeCalls.subscriptions.mockImplementation(updateLive);
    const { seats } = await t.action(api.stripe.addSeat, {});
    await t.mutation(api.org.members.add, {
      orgId: payerOrgId,
      email: "fourth@example.com",
    });

    expect(seats).toBe(3);
    expect(await memberCount(t)).toBe(4);
  });

  test("a developer in two of the owner's orgs takes one seat, and joins the second free while the pool is full", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedIncludedSeatsTaken(t);
    await seedUser(t, "auth_new", "new@example.com");
    const second = await t.mutation(api.org.orgs.create, { name: "Second" });

    await t.mutation(api.org.members.add, {
      orgId: second,
      email: "dev-one@example.com",
    });

    expect(await t.query(api.stripe.getBillingInfo, {})).toMatchObject({
      seats: 2,
      developers: 2,
    });
    expect(await t.query(api.stripe.listSeatHolders, {})).toEqual([
      {
        userId: expect.any(String),
        name: "auth_dev_one",
        orgs: ["Payer Org", "Second"],
      },
      { userId: expect.any(String), name: "auth_dev_two", orgs: ["Payer Org"] },
    ]);
    // The pool is full, so someone new needs a seat in any of the orgs.
    await expect(
      t.mutation(api.org.members.add, {
        orgId: second,
        email: "new@example.com",
      }),
    ).rejects.toThrow("Every developer seat is taken");
  });

  test("billing shows the owner their pool and every org they own, and a member only the plan's status", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(
      t,
      "customer.subscription.created",
      subscription("active", SUBSCRIPTION_ID, 3),
    );
    const second = await t.mutation(api.org.orgs.create, { name: "Second" });
    await addMember(t, "auth_member", "member@example.com");

    expect(await t.query(api.stripe.listOwnedOrgs, {})).toEqual([
      { orgId: payerOrgId, name: "Payer Org", plan: "pro" },
      { orgId: second, name: "Second", plan: "pro" },
    ]);
    // 3 units: Pro with its 2 included developer seats, and 2 extra seats.
    expect(await t.query(api.stripe.getBillingInfo, {})).toMatchObject({
      kind: "owner",
      seats: 4,
      developers: 1,
    });
    caller.authId = "auth_member";
    expect(await t.query(api.stripe.getBillingInfo, {})).toEqual({
      kind: "member",
      status: "active",
    });
    expect(await t.query(api.stripe.listOwnedOrgs, {})).toEqual([]);
    expect(await t.query(api.stripe.listSeatHolders, {})).toEqual([]);
  });

  test("once the owner cancels, a developer seated in one org cannot join another", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedIncludedSeatsTaken(t);
    const second = await seedOrg(t, "Second");
    await sendEvent(
      t,
      "customer.subscription.deleted",
      subscription("canceled"),
    );

    await expect(
      t.mutation(api.org.members.add, {
        orgId: second,
        email: "dev-one@example.com",
      }),
    ).rejects.toThrow("which has no developer seats");
  });

  test("a self-hosted install invites without seats", async () => {
    const t = billingTest();
    await seedPayer(t);
    await seedUser(t, "auth_new", "new@example.com");

    await t.mutation(api.org.members.add, {
      orgId: payerOrgId,
      email: "new@example.com",
    });

    expect(await memberCount(t)).toBe(2);
  });

  test("Add seat charges the prorated seat at once, then the invite lands", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedIncludedSeatsTaken(t);
    await seedUser(t, "auth_new", "new@example.com");
    stripeCalls.subscriptions.mockImplementation(updateLive);

    const { seats } = await t.action(api.stripe.addSeat, {});
    await t.mutation(api.org.members.add, {
      orgId: payerOrgId,
      email: "new@example.com",
    });

    expect(seats).toBe(3);
    expect(stripeCalls.subscriptions).toHaveBeenCalledWith(SUBSCRIPTION_ID, {
      items: [{ price: "price_seat", quantity: 1 }],
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
    });
    expect(await memberCount(t)).toBe(4);
  });

  test("Add seat pays for developers kept from Hobby too", async () => {
    const t = billingTest();
    await seedPayer(t);
    for (const name of ["a", "b", "c", "d"]) {
      await addMember(t, `auth_kept_${name}`, `${name}@example.com`);
    }
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    stripeCalls.subscriptions.mockImplementation(updateLive);

    const { seats } = await t.action(api.stripe.addSeat, {});

    // 4 developers and the one to come: Pro with its 2 included seats, 3 extra.
    expect(seats).toBe(5);
  });

  test("Add seat with a seat already free charges nothing, so a second tab or a retry never pays twice", async () => {
    const t = billingTest();
    await seedIncludedSeatsTaken(t);
    stripeCalls.subscriptions.mockImplementation(updateLive);

    const first = await t.action(api.stripe.addSeat, {});
    const second = await t.action(api.stripe.addSeat, {});

    expect([first.seats, second.seats]).toEqual([3, 3]);
    expect(stripeCalls.subscriptions).toHaveBeenCalledTimes(1);
  });

  test("a webhook read that started before Add seat cannot land over the new seat", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedIncludedSeatsTaken(t);
    await seedUser(t, "auth_new", "new@example.com");
    // A webhook reads the one unit Stripe still holds, after Add seat read it.
    stripeCalls.subscriptions.mockImplementation(
      async (id: string, params: Stripe.SubscriptionUpdateParams) => {
        await sendEvent(
          t,
          "customer.subscription.updated",
          subscription("active"),
          "evt_mid_seat",
        );

        return await updateLive(id, params);
      },
    );

    await t.action(api.stripe.addSeat, {});
    await t.mutation(api.org.members.add, {
      orgId: payerOrgId,
      email: "new@example.com",
    });

    expect(await memberCount(t)).toBe(4);
  });

  test("a declined card adds no seat and the invite stays refused", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedIncludedSeatsTaken(t);
    await seedUser(t, "auth_new", "new@example.com");
    stripeCalls.subscriptions.mockRejectedValue(
      new Stripe.errors.StripeCardError({
        message: "Your card was declined.",
        type: "card_error",
      }),
    );

    await expect(t.action(api.stripe.addSeat, {})).rejects.toThrow(
      "The seat was not added: Your card was declined.",
    );
    await expect(
      t.mutation(api.org.members.add, {
        orgId: payerOrgId,
        email: "new@example.com",
      }),
    ).rejects.toThrow("Every developer seat");
  });

  test("a Hobby owner cannot add seats", async () => {
    const t = billingTest();
    await seedPayer(t);

    await expect(t.action(api.stripe.addSeat, {})).rejects.toThrow(
      "Upgrade to Pro before adding seats",
    );
    expect(stripeCalls.subscriptions).not.toHaveBeenCalled();
  });

  test("removing a developer past the included seats gives their extra seat back with a proration credit", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedIncludedSeatsTaken(t, 2);
    const membershipId = await addMember(
      t,
      "auth_member",
      "member@example.com",
    );
    stripeCalls.subscriptions.mockImplementation(updateLive);

    vi.useFakeTimers();
    await t.mutation(api.org.members.remove, { membershipId: membershipId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(stripeCalls.subscriptions).toHaveBeenCalledWith(SUBSCRIPTION_ID, {
      items: [{ id: ITEM_ID, deleted: true }],
      proration_behavior: "create_prorations",
      payment_behavior: "error_if_incomplete",
    });
    const sub = await t.query(components.stripe.public.getSubscription, {
      stripeSubscriptionId: SUBSCRIPTION_ID,
    });
    expect(sub?.quantity).toBe(1);
  });

  test("a developer who leaves one org but stays in another keeps their seat", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedIncludedSeatsTaken(t, 2);
    const second = await seedOrg(t, "Second");
    const membershipId = await addMember(
      t,
      "auth_member",
      "member@example.com",
    );
    await addMember(t, "auth_member", "member@example.com", second);

    vi.useFakeTimers();
    await t.mutation(api.org.members.remove, { membershipId: membershipId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(stripeCalls.subscriptions).not.toHaveBeenCalled();
    const sub = await t.query(components.stripe.public.getSubscription, {
      stripeSubscriptionId: SUBSCRIPTION_ID,
    });
    expect(sub?.quantity).toBe(2);
  });

  test("a seat sync that lands after Stripe ended the subscription changes nothing", async () => {
    const t = billingTest();
    await seedIncludedSeatsTaken(t, 2);
    // A deleted owner's cancel reached Stripe; its webhook has not landed yet.
    stripeCalls.live.set(
      SUBSCRIPTION_ID,
      subscription("canceled", SUBSCRIPTION_ID, 2),
    );

    await t.action(internal.stripe.syncSeatsInternal, { authId: AUTH_ID });

    expect(stripeCalls.subscriptions).not.toHaveBeenCalled();
    const sub = await t.query(components.stripe.public.getSubscription, {
      stripeSubscriptionId: SUBSCRIPTION_ID,
    });
    expect(sub?.status).toBe("canceled");
  });

  test("a subscription bought as seat units alone gets its Pro line and drops to the new count on its next sync", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await addMember(t, "auth_kept", "kept@example.com");
    const membershipId = await addMember(
      t,
      "auth_member",
      "member@example.com",
    );
    // Three members at the old one seat unit each, with no Pro line.
    await sendEvent(t, "customer.subscription.created", {
      ...subscription("active"),
      items: { data: [seatItem(3)] },
    });
    stripeCalls.subscriptions.mockImplementation(updateLive);

    vi.useFakeTimers();
    await t.mutation(api.org.members.remove, { membershipId: membershipId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(stripeCalls.subscriptions).toHaveBeenCalledWith(SUBSCRIPTION_ID, {
      items: [
        { price: "price_pro", quantity: 1 },
        { id: ITEM_ID, deleted: true },
      ],
      proration_behavior: "create_prorations",
      payment_behavior: "error_if_incomplete",
    });
  });

  test("a developer whose account is deleted gives their seat back, even while payment is due", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedIncludedSeatsTaken(t, 2, "past_due");
    await addMember(t, "auth_member", "member@example.com");
    stripeCalls.subscriptions.mockImplementation(updateLive);

    vi.useFakeTimers();
    await t.mutation(internal.org.workosUserDeletion.finalize, {
      authId: "auth_member",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(stripeCalls.subscriptions).toHaveBeenCalledWith(
      SUBSCRIPTION_ID,
      expect.objectContaining({
        items: [{ id: ITEM_ID, deleted: true }],
      }),
    );
  });
});

// A Pro owner creates as many orgs as they like, each on Pro. Everyone else
// keeps the one Hobby workspace made for them.
describe("creating an org", () => {
  test("a Hobby user cannot create a second org", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);

    await expect(
      t.mutation(api.org.orgs.create, { name: "Second" }),
    ).rejects.toThrow(
      "Creating another organization needs Pro. Upgrade to Pro first.",
    );
    expect(await ownedOrgCount(t)).toBe(1);
  });

  test("a Pro owner creates orgs up to 10, each on Pro, and the eleventh is refused", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));

    const created = [];
    for (let index = 2; index <= 10; index += 1) {
      created.push(
        await t.mutation(api.org.orgs.create, { name: `Org ${index}` }),
      );
    }

    expect(
      await Promise.all(created.map(async (orgId) => await orgPlan(t, orgId))),
    ).toEqual(Array<string>(9).fill("pro"));
    await expect(
      t.mutation(api.org.orgs.create, { name: "Org 11" }),
    ).rejects.toThrow("You own 10 organizations, the most Pro allows.");
    expect(await ownedOrgCount(t)).toBe(10);
  });

  test("an owner whose payment is due is told to fix it, not to upgrade", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(
      t,
      "customer.subscription.created",
      subscription("past_due"),
    );

    await expect(
      t.mutation(api.org.orgs.create, { name: "Second" }),
    ).rejects.toThrow(
      "Payment for your Pro plan is due. Update the card in Billing first.",
    );
    expect(await ownedOrgCount(t)).toBe(1);
  });

  test("a Hobby user who joined someone else's org still gets their own workspace, and only that", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await addMember(t, "auth_member", "member@example.com");
    caller.authId = "auth_member";

    await t.mutation(api.org.orgs.create, { name: "Member Workspace" });

    await expect(
      t.mutation(api.org.orgs.create, { name: "Member Second" }),
    ).rejects.toThrow("Creating another organization needs Pro");
  });

  test("broods login answers the cap as 402 payment_required", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    const token = "bcli_payer";
    await t.run(async (ctx) => {
      const now = Date.now();
      const accountId = await ctx.db.insert("accounts", {
        orgId: payerOrgId,
        username: "payer-org",
        secretHash: "hash-payer",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("cliTokens", {
        tokenHash: createHash("sha256").update(token).digest("hex"),
        authId: AUTH_ID,
        orgId: payerOrgId,
        accountId: accountId,
        status: "active",
        createdAt: now,
      });
    });

    const response = await t.fetch("/v1/account/onboarding", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ createOrgName: "Second" }),
    });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: { code: "payment_required" },
    });
    expect(await ownedOrgCount(t)).toBe(1);
  });

  test("an adopted account's org runs on its owner's Pro plan", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    const accountId = await t.run(
      async (ctx) =>
        await ctx.db.insert("accounts", {
          orgId: "external:payer",
          username: "payer-external",
          secretHash: "hash-payer-external",
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
    );

    const { orgId } = await t.mutation(internal.org.orgs.adoptExternalAccount, {
      accountId: accountId,
      ownerEmail: "payer@example.com",
      orgName: "Adopted",
    });

    expect(await orgPlan(t, orgId)).toBe("pro");
  });

  test("an operator adopts an account for a Hobby owner: no org-count gate, the owner's plan, the owner's pool", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    const [ownAccountId, externalId] = await t.run(async (ctx) => {
      const now = Date.now();
      const account = {
        secretHash: "hash",
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      };

      return [
        await ctx.db.insert("accounts", {
          ...account,
          orgId: payerOrgId,
          username: "payer-org",
        }),
        await ctx.db.insert("accounts", {
          ...account,
          orgId: "external:payer",
          username: "payer-external",
        }),
      ];
    });

    const { orgId } = await t.mutation(internal.org.orgs.adoptExternalAccount, {
      accountId: externalId,
      ownerEmail: "payer@example.com",
      orgName: "Adopted",
    });
    await t.mutation(internal.account.budget.record, {
      accountId: externalId,
      usage: { egressGb: PLAN_LIMITS.free.caps.egressGb },
    });

    expect(await ownedOrgCount(t)).toBe(2);
    expect(await orgPlan(t, orgId)).toBe("free");
    // The adopted org's usage stops the owner's own workspace too: one pool.
    expect(
      await t.query(internal.account.budget.get, { accountId: ownAccountId }),
    ).toMatchObject({ plan: "free", usedPercent: 100 });
  });

  test("a self-hosted install creates orgs without Pro", async () => {
    const t = billingTest();
    await seedPayer(t);

    await t.mutation(api.org.orgs.create, { name: "Second" });

    expect(await ownedOrgCount(t)).toBe(2);
  });
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_billing");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("STRIPE_PRO_PRICE_ID", "price_pro");
  vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
  // Stripe has every customer the component filed, unless a test says not.
  stripeCalls.retrieveCustomer.mockImplementation(
    async (id: string): Promise<Record<string, unknown>> => ({
      id: id,
      object: "customer",
    }),
  );
  // processEvent also fetches the latest invoice on checkout completion.
  stripeCalls.retrieveSubscription.mockImplementation(
    async (id: string): Promise<Record<string, unknown>> =>
      stripeCalls.live.get(id) ?? { latest_invoice: null },
  );
});

afterEach(() => {
  caller.authId = AUTH_ID;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  stripeCalls.live.clear();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function billingTest(): T {
  const t = convexTest(schema, modules);
  t.registerComponent("stripe", stripeSchema, stripeModules);

  return t;
}

function checkout(clientReferenceId: string): Record<string, unknown> {
  return {
    id: "cs_payer",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    client_reference_id: clientReferenceId,
    customer: CUSTOMER_ID,
    customer_details: { email: "payer@example.com" },
    subscription: SUBSCRIPTION_ID,
    metadata: {},
  };
}

async function plans(t: T): Promise<{ user: string; org: string }> {
  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", AUTH_ID))
      .unique();
    const org = await ctx.db.get(payerOrgId);

    return { user: user?.plan ?? "missing", org: org?.plan ?? "missing" };
  });
}

async function orgPlan(t: T, orgId: Id<"orgs">): Promise<string | undefined> {
  return await t.run(async (ctx) => (await ctx.db.get(orgId))?.plan);
}

/** The payer and the Hobby org they own. */
async function seedPayer(t: T): Promise<void> {
  await seedUser(t, AUTH_ID, "payer@example.com");
  payerOrgId = await seedOrg(t, "Payer Org");
}

/** An org `ownerAuthId` owns, on Hobby, with their owner membership. */
async function seedOrg(
  t: T,
  name: string,
  ownerAuthId = AUTH_ID,
): Promise<Id<"orgs">> {
  return await t.run(async (ctx) => {
    const owner = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", ownerAuthId))
      .unique();
    if (!owner) throw new Error("Seed the owner first");
    const orgId = await ctx.db.insert("orgs", {
      name: name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      ownerAuthId: ownerAuthId,
      plan: "free",
      createdAt: Date.now(),
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: owner._id,
      role: "owner",
      createdAt: Date.now(),
    });

    return orgId;
  });
}

async function seedUser(t: T, authId: string, email: string): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      authId: authId,
      email: email,
      name: authId,
      plan: "free",
    });
  });
}

/** A user, new unless seeded already, who joined an org as an admin before seats were counted. */
async function addMember(
  t: T,
  authId: string,
  email: string,
  orgId = payerOrgId,
): Promise<Id<"orgMembers">> {
  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .unique();
    const userId =
      user?._id ??
      (await ctx.db.insert("users", {
        authId: authId,
        email: email,
        name: authId,
        plan: "free",
      }));

    return await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "admin",
      createdAt: Date.now(),
    });
  });
}

/** The payer on Pro at `quantity` units, their 2 included developer seats taken in their org. */
async function seedIncludedSeatsTaken(
  t: T,
  quantity = 1,
  status: Stripe.Subscription.Status = "active",
): Promise<void> {
  await seedPayer(t);
  await addMember(t, "auth_dev_one", "dev-one@example.com");
  await addMember(t, "auth_dev_two", "dev-two@example.com");
  await sendEvent(
    t,
    "customer.subscription.created",
    subscription(status, SUBSCRIPTION_ID, quantity),
  );
}

async function memberCount(t: T): Promise<number> {
  return await t.run(async (ctx) => {
    const members = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", payerOrgId))
      .collect();

    return members.length;
  });
}

async function ownedOrgCount(t: T): Promise<number> {
  return await t.run(async (ctx) => {
    const orgs = await ctx.db
      .query("orgs")
      .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", AUTH_ID))
      .collect();

    return orgs.length;
  });
}

/** Stripe's answer to a seat change: the subscription at its new units, its Pro line kept. */
async function updateLive(
  id: string,
  params: Stripe.SubscriptionUpdateParams,
): Promise<Record<string, unknown>> {
  const seats = (params.items ?? [])
    .filter((item) => item.price === "price_seat")
    .reduce((units, item) => units + (item.quantity ?? 1), 0);
  const next = subscription("active", id, 1 + seats);
  stripeCalls.live.set(id, next);

  return next;
}

/**
 * Make a subscription event's object what Stripe holds now, then deliver the
 * event and require a 200.
 */
async function sendEvent(
  t: T,
  type: string,
  object: Record<string, unknown>,
  eventId = `evt_${type}`,
): Promise<void> {
  if (
    type.startsWith("customer.subscription.") &&
    typeof object.id === "string"
  ) {
    stripeCalls.live.set(object.id, object);
  }

  expect((await deliver(t, eventId, type, object)).status).toBe(200);
}

/** POST a signed Stripe event to the webhook route. Stripe's state stays as is. */
async function deliver(
  t: T,
  eventId: string,
  type: string,
  object: Record<string, unknown>,
): Promise<Response> {
  const payload = JSON.stringify({
    id: eventId,
    object: "event",
    type: type,
    data: { object: object },
  });
  const signature = await new Stripe(
    "sk_test_billing",
  ).webhooks.generateTestHeaderStringAsync({
    payload: payload,
    secret: WEBHOOK_SECRET,
  });

  return await t.fetch("/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });
}

/** A subscription as Stripe returns it, its Pro line then any extra seats; by default the payer's. */
function subscription(
  status: Stripe.Subscription.Status,
  id = SUBSCRIPTION_ID,
  quantity = 1,
  metadata: Record<string, string> = { userId: AUTH_ID },
): Record<string, unknown> {
  return {
    id: id,
    object: "subscription",
    customer: CUSTOMER_ID,
    status: status,
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: metadata,
    items: {
      data: [
        {
          id: PRO_ITEM_ID,
          current_period_end: 1_900_000_000,
          quantity: 1,
          price: { id: "price_pro" },
        },
        ...(quantity > 1 ? [seatItem(quantity - 1)] : []),
      ],
    },
  };
}

/** A subscription's seat line at `quantity` units. */
function seatItem(quantity: number): Record<string, unknown> {
  return {
    id: ITEM_ID,
    current_period_end: 1_900_000_000,
    quantity: quantity,
    price: { id: "price_seat" },
  };
}
