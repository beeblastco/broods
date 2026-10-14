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
import { proQuantity } from "../model/orgBilling";
import { stripeClient } from "../stripe";

const AUTH_ID = "auth_payer";
const CUSTOMER_ID = "cus_payer";
const SUBSCRIPTION_ID = "sub_payer";
const ITEM_ID = "si_payer";
const WEBHOOK_SECRET = "whsec_billing_test";

const stripeCalls = vi.hoisted(() => ({
  customers: vi.fn(),
  // What Stripe holds now, by subscription id. The webhook reads it back.
  live: new Map<string, Record<string, unknown>>(),
  retrieveSubscription: vi.fn(),
  subscriptions: vi.fn(),
}));

// Who is signed in.
const caller = vi.hoisted(() => ({ authId: "auth_payer" }));

// The org `seedPayer` made, which subscriptions pay for unless told otherwise.
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

// One subscription per org (#1024): it pays for that org alone, and only the
// org's owner starts it, changes its seats or opens its portal.
describe("per-org billing", () => {
  test("a subscription upgrades only the org it pays for", async () => {
    const t = billingTest();
    await seedPayer(t);
    const other = await seedOrg(t, "Second Org");

    await sendEvent(t, "customer.subscription.created", subscription("active"));

    expect(await plans(t)).toEqual({ user: "pro", org: "pro" });
    expect(await orgPlan(t, other)).toBe("free");
  });

  test("a subscription filed under no org changes no org's plan", async () => {
    const t = billingTest();
    await seedPayer(t);

    await sendEvent(
      t,
      "customer.subscription.created",
      subscription("active", SUBSCRIPTION_ID, 1, { userId: AUTH_ID }),
    );

    expect(await plans(t)).toEqual({ user: "pro", org: "free" });
  });

  test.each([
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 2],
    [5, 3],
  ])(
    "Pro for %i members, owner included, is %i units: the owner and 2 developers, then one per extra seat",
    (members, units) => {
      expect(proQuantity(members)).toBe(units);
    },
  );

  test("checkout bills the owner one Pro unit while the included seats cover every member", async () => {
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
    const t = billingTest();
    await seedPayer(t);
    await addMember(t, "auth_member", "member@example.com");
    const customer = vi
      .spyOn(stripeClient, "getOrCreateCustomer")
      .mockResolvedValue({ customerId: CUSTOMER_ID, isNew: false });
    const checkoutSession = vi
      .spyOn(stripeClient, "createCheckoutSession")
      .mockResolvedValue({ sessionId: "cs_org", url: "https://checkout.test" });

    const { url } = await t.action(api.stripe.createCheckoutSession, {
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/cancel",
    });

    expect(url).toBe("https://checkout.test");
    expect(customer).toHaveBeenCalledWith(expect.anything(), {
      userId: AUTH_ID,
      email: "payer@example.com",
    });
    expect(checkoutSession).toHaveBeenCalledWith(expect.anything(), {
      priceId: "price_seat",
      customerId: CUSTOMER_ID,
      mode: "subscription",
      quantity: 1,
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/cancel",
      subscriptionMetadata: { userId: AUTH_ID, orgId: payerOrgId },
    });
  });

  test("upgrading a free org that kept 5 members bills Pro plus 2 extra seats", async () => {
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
    const t = billingTest();
    await seedPayer(t);
    for (const name of ["a", "b", "c", "d"]) {
      await addMember(t, `auth_kept_${name}`, `${name}@example.com`);
    }
    vi.spyOn(stripeClient, "getOrCreateCustomer").mockResolvedValue({
      customerId: CUSTOMER_ID,
      isNew: false,
    });
    const checkoutSession = vi
      .spyOn(stripeClient, "createCheckoutSession")
      .mockResolvedValue({ sessionId: "cs_org", url: "https://checkout.test" });

    await t.action(api.stripe.createCheckoutSession, {
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/cancel",
    });

    expect(checkoutSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quantity: 3 }),
    );
  });

  test("a member who clicks Upgrade in someone else's org is refused and not charged", async () => {
    const t = billingTest();
    await seedPayer(t);
    await addMember(t, "auth_member", "member@example.com");
    const customer = vi.spyOn(stripeClient, "getOrCreateCustomer");
    caller.authId = "auth_member";

    await expect(
      t.action(api.stripe.createCheckoutSession, {
        successUrl: "http://localhost:3000/ok",
        cancelUrl: "http://localhost:3000/cancel",
      }),
    ).rejects.toThrow("Only the organization's owner");
    await expect(
      t.action(api.stripe.createPortalSession, {
        returnUrl: "http://localhost:3000/billing",
      }),
    ).rejects.toThrow("Only the organization's owner");

    expect(customer).not.toHaveBeenCalled();
    expect(await plans(t)).toEqual({ user: "free", org: "free" });
  });

  test("refuses a second checkout while the org has a live subscription", async () => {
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

  test("getBillingInfo shows a member the org's subscription", async () => {
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

    // The seats count only while it is paid; who pays stays with the owner.
    expect(info).toEqual({
      status: "past_due",
      currentPeriodEnd: expect.any(Number),
      cancelAtPeriodEnd: false,
      seats: 1,
      extraSeats: 0,
    });
  });

  test("getBillingInfo returns null once the subscription is canceled", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    await sendEvent(
      t,
      "customer.subscription.deleted",
      subscription("canceled"),
    );

    expect(await t.query(api.stripe.getBillingInfo, {})).toBeNull();
  });

  test("deleting an org cancels its subscription", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    const cancel = vi
      .spyOn(stripeClient, "cancelSubscription")
      .mockResolvedValue(null);

    vi.useFakeTimers();
    await t.mutation(api.org.orgs.remove, { orgId: payerOrgId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(cancel).toHaveBeenCalledWith(expect.anything(), {
      stripeSubscriptionId: SUBSCRIPTION_ID,
      cancelAtPeriodEnd: false,
    });
  });
});

// Pro seats the owner and 2 developers; the owner pays for each seat past
// those before the member it is for can join.
describe("seats", () => {
  test("a Hobby org has the owner's seat only, so its invite is refused", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await seedUser(t, "auth_new", "new@example.com");

    await expect(
      t.mutation(api.org.members.add, {
        orgId: payerOrgId,
        email: "new@example.com",
      }),
    ).rejects.toThrow("Payer Org is on Hobby, which has one seat");
    expect(await memberCount(t)).toBe(1);
  });

  test("Pro invites 2 developers, then the next one needs a seat", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
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
    ).rejects.toThrow("Every seat");
    stripeCalls.subscriptions.mockImplementation(updateLive);
    const { seats } = await t.action(api.stripe.addSeat, {
      orgId: payerOrgId,
    });
    await t.mutation(api.org.members.add, {
      orgId: payerOrgId,
      email: "fourth@example.com",
    });

    expect(seats).toBe(4);
    expect(await memberCount(t)).toBe(4);
  });

  test("billing shows every member the paid seats, and the owner each org they own", async () => {
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

    // 3 units: Pro with its 2 included seats, and 2 extra seats.
    expect(await t.query(api.stripe.listOwnedOrgs, {})).toEqual([
      { orgId: payerOrgId, name: "Payer Org", plan: "pro", seats: 5 },
      { orgId: second, name: "Second", plan: "free", seats: 1 },
    ]);
    caller.authId = "auth_member";
    expect(await t.query(api.stripe.getBillingInfo, {})).toMatchObject({
      seats: 5,
      extraSeats: 2,
    });
    expect(await t.query(api.stripe.listOwnedOrgs, {})).toEqual([]);
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
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
    const t = billingTest();
    await seedIncludedSeatsTaken(t);
    await seedUser(t, "auth_new", "new@example.com");
    stripeCalls.subscriptions.mockImplementation(updateLive);

    const { seats } = await t.action(api.stripe.addSeat, {
      orgId: payerOrgId,
    });
    await t.mutation(api.org.members.add, {
      orgId: payerOrgId,
      email: "new@example.com",
    });

    expect(seats).toBe(4);
    expect(stripeCalls.subscriptions).toHaveBeenCalledWith(SUBSCRIPTION_ID, {
      items: [{ id: ITEM_ID, price: "price_seat", quantity: 2 }],
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
    });
    expect(await memberCount(t)).toBe(4);
  });

  test("Add seat pays for members kept from the free plan too", async () => {
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
    const t = billingTest();
    await seedPayer(t);
    for (const name of ["a", "b", "c", "d"]) {
      await addMember(t, `auth_kept_${name}`, `${name}@example.com`);
    }
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    stripeCalls.subscriptions.mockImplementation(updateLive);

    const { seats } = await t.action(api.stripe.addSeat, {
      orgId: payerOrgId,
    });

    // 5 members and the one to come: Pro with its 2 included seats, 3 extra.
    expect(seats).toBe(6);
  });

  test("Add seat with a seat already free charges nothing, so a second tab or a retry never pays twice", async () => {
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
    const t = billingTest();
    await seedIncludedSeatsTaken(t);
    stripeCalls.subscriptions.mockImplementation(updateLive);

    const first = await t.action(api.stripe.addSeat, { orgId: payerOrgId });
    const second = await t.action(api.stripe.addSeat, { orgId: payerOrgId });

    expect([first.seats, second.seats]).toEqual([4, 4]);
    expect(stripeCalls.subscriptions).toHaveBeenCalledTimes(1);
  });

  test("a webhook read that started before Add seat cannot land over the new seat", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
    const t = billingTest();
    await seedIncludedSeatsTaken(t);
    await seedUser(t, "auth_new", "new@example.com");
    // A webhook reads the one seat Stripe still holds, after Add seat read it.
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

    await t.action(api.stripe.addSeat, { orgId: payerOrgId });
    await t.mutation(api.org.members.add, {
      orgId: payerOrgId,
      email: "new@example.com",
    });

    expect(await memberCount(t)).toBe(4);
  });

  test("a declined card adds no seat and the invite stays refused", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
    const t = billingTest();
    await seedIncludedSeatsTaken(t);
    await seedUser(t, "auth_new", "new@example.com");
    stripeCalls.subscriptions.mockRejectedValue(
      new Stripe.errors.StripeCardError({
        message: "Your card was declined.",
        type: "card_error",
      }),
    );

    await expect(
      t.action(api.stripe.addSeat, { orgId: payerOrgId }),
    ).rejects.toThrow("The seat was not added: Your card was declined.");
    await expect(
      t.mutation(api.org.members.add, {
        orgId: payerOrgId,
        email: "new@example.com",
      }),
    ).rejects.toThrow("Every seat");
  });

  test("only the owner adds seats, and only to a paid org", async () => {
    const t = billingTest();
    await seedPayer(t);
    await addMember(t, "auth_admin", "admin@example.com");

    await expect(
      t.action(api.stripe.addSeat, { orgId: payerOrgId }),
    ).rejects.toThrow("Upgrade this organization before adding seats");
    await sendEvent(t, "customer.subscription.created", subscription("active"));
    caller.authId = "auth_admin";
    await expect(
      t.action(api.stripe.addSeat, { orgId: payerOrgId }),
    ).rejects.toThrow("Only the organization's owner");

    expect(stripeCalls.subscriptions).not.toHaveBeenCalled();
  });

  test("removing a member past the included seats gives their extra seat back with a proration credit", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
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
      items: [{ id: ITEM_ID, price: "price_seat", quantity: 1 }],
      proration_behavior: "create_prorations",
      payment_behavior: "error_if_incomplete",
    });
    const sub = await t.query(components.stripe.public.getSubscription, {
      stripeSubscriptionId: SUBSCRIPTION_ID,
    });
    expect(sub?.quantity).toBe(1);
  });

  test("a subscription bought at one seat per member drops to the new count on its next sync", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
    const t = billingTest();
    await seedPayer(t);
    await addMember(t, "auth_kept", "kept@example.com");
    const membershipId = await addMember(
      t,
      "auth_member",
      "member@example.com",
    );
    // Three members at the old one unit each.
    await sendEvent(
      t,
      "customer.subscription.created",
      subscription("active", SUBSCRIPTION_ID, 3),
    );
    stripeCalls.subscriptions.mockImplementation(updateLive);

    vi.useFakeTimers();
    await t.mutation(api.org.members.remove, { membershipId: membershipId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(stripeCalls.subscriptions).toHaveBeenCalledWith(SUBSCRIPTION_ID, {
      items: [{ id: ITEM_ID, price: "price_seat", quantity: 1 }],
      proration_behavior: "create_prorations",
      payment_behavior: "error_if_incomplete",
    });
  });

  test("a member whose account is deleted gives their seat back, even while payment is due", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
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
        items: [{ id: ITEM_ID, price: "price_seat", quantity: 1 }],
      }),
    );
  });
});

// Creating an org needs Pro, so a new org never brings a new free allowance.
// Everyone still gets their own Hobby workspace.
describe("creating an org", () => {
  test("a Hobby user cannot create a second org", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);

    await expect(
      t.mutation(api.org.orgs.create, { name: "Second" }),
    ).rejects.toThrow(
      "Creating an organization needs Pro. Upgrade Payer Org to Pro first",
    );
    expect(await ownedOrgCount(t)).toBe(1);
  });

  test("a Pro owner creates an org, which is upgraded before the next one", async () => {
    vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.subscription.created", subscription("active"));

    const second = await t.mutation(api.org.orgs.create, { name: "Second" });

    expect(await orgPlan(t, second)).toBe("free");
    await expect(
      t.mutation(api.org.orgs.create, { name: "Third" }),
    ).rejects.toThrow("Second is still on Hobby");
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
    ).rejects.toThrow("Creating an organization needs Pro");
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

  test("a self-hosted install creates orgs without Pro", async () => {
    const t = billingTest();
    await seedPayer(t);

    await t.mutation(api.org.orgs.create, { name: "Second" });

    expect(await ownedOrgCount(t)).toBe(2);
  });
});

// The cutover: subscriptions filed under a user move onto one org they own.
describe("billing migration", () => {
  test("a dry run lists the move and changes nothing", async () => {
    const t = billingTest();
    const { small, large } = await seedPreCutover(t);

    const moves = await t.action(
      internal.billingMigration.moveUserSubscriptionsToOrgs,
      { dryRun: true },
    );

    expect(moves).toEqual([
      { authId: AUTH_ID, stripeSubscriptionId: SUBSCRIPTION_ID, orgId: large },
    ]);
    expect(stripeCalls.subscriptions).not.toHaveBeenCalled();
    expect(await orgPlan(t, small)).toBe("pro");
    expect(await orgPlan(t, large)).toBe("pro");
  });

  test("moves the subscription onto the owner's largest org and frees the rest", async () => {
    const t = billingTest();
    const { small, large } = await seedPreCutover(t);

    await t.action(internal.billingMigration.moveUserSubscriptionsToOrgs, {
      dryRun: false,
    });

    expect(stripeCalls.subscriptions).toHaveBeenCalledWith(SUBSCRIPTION_ID, {
      metadata: { userId: AUTH_ID, orgId: large },
    });
    const sub = await t.query(components.stripe.public.getSubscription, {
      stripeSubscriptionId: SUBSCRIPTION_ID,
    });
    expect(sub?.orgId).toBe(large);
    expect(await orgPlan(t, large)).toBe("pro");
    expect(await orgPlan(t, small)).toBe("free");
    expect((await plans(t)).user).toBe("pro");
  });

  test("a user who stopped paying gets every owned org back to free", async () => {
    const t = billingTest();
    const { small, large } = await seedPreCutover(t);
    await sendEvent(
      t,
      "customer.subscription.deleted",
      subscription("canceled", SUBSCRIPTION_ID, 1, { userId: AUTH_ID }),
    );

    const moves = await t.action(
      internal.billingMigration.moveUserSubscriptionsToOrgs,
      { dryRun: false },
    );

    expect(moves).toEqual([]);
    expect(await orgPlan(t, small)).toBe("free");
    expect(await orgPlan(t, large)).toBe("free");
  });
});

// The cutover to Pro's included seats: a subscription bought at one unit per
// member drops to what its members need now, not when someone leaves.
describe("seat migration", () => {
  test("a dry run reports an old-formula 3-member org at 3 to 1 units and changes nothing", async () => {
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
    const t = billingTest();
    await seedIncludedSeatsTaken(t, 3);

    const resyncs = await t.action(internal.seatMigration.resyncAllSeats, {
      dryRun: true,
    });

    expect(resyncs).toEqual([
      { orgId: payerOrgId, oldQuantity: 3, newQuantity: 1 },
    ]);
    expect(stripeCalls.subscriptions).not.toHaveBeenCalled();
  });

  test("the real run sets it to 1 unit, and a second run changes nothing", async () => {
    vi.stubEnv("STRIPE_SEAT_PRICE_ID", "price_seat");
    const t = billingTest();
    await seedIncludedSeatsTaken(t, 3);
    stripeCalls.subscriptions.mockImplementation(updateLive);

    await t.action(internal.seatMigration.resyncAllSeats, { dryRun: false });
    const again = await t.action(internal.seatMigration.resyncAllSeats, {
      dryRun: false,
    });

    expect(stripeCalls.subscriptions).toHaveBeenCalledTimes(1);
    expect(stripeCalls.subscriptions).toHaveBeenCalledWith(SUBSCRIPTION_ID, {
      items: [{ id: ITEM_ID, price: "price_seat", quantity: 1 }],
      proration_behavior: "create_prorations",
      payment_behavior: "error_if_incomplete",
    });
    const sub = await t.query(components.stripe.public.getSubscription, {
      stripeSubscriptionId: SUBSCRIPTION_ID,
    });
    expect(sub?.quantity).toBe(1);
    expect(again).toEqual([]);
  });
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_billing");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
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

/** The payer and the free org they own, which `subscription` pays for. */
async function seedPayer(t: T): Promise<void> {
  await seedUser(t, AUTH_ID, "payer@example.com");
  payerOrgId = await seedOrg(t, "Payer Org");
}

/** An org the payer owns, with their owner membership. */
async function seedOrg(
  t: T,
  name: string,
  plan: "free" | "pro" = "free",
  createdAt = Date.now(),
): Promise<Id<"orgs">> {
  return await t.run(async (ctx) => {
    const owner = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", AUTH_ID))
      .unique();
    if (!owner) throw new Error("Seed the payer first");
    const orgId = await ctx.db.insert("orgs", {
      name: name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      ownerAuthId: AUTH_ID,
      plan: plan,
      createdAt: createdAt,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: owner._id,
      role: "owner",
      createdAt: createdAt,
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

/** A new user who joined an org of the payer's as an admin, before seats were counted. */
async function addMember(
  t: T,
  authId: string,
  email: string,
  orgId = payerOrgId,
): Promise<Id<"orgMembers">> {
  await seedUser(t, authId, email);

  return await t.run(async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .unique();
    if (!user) throw new Error("Seed the user first");

    return await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: user._id,
      role: "admin",
      createdAt: Date.now(),
    });
  });
}

/** The payer's org on Pro at `quantity` units, its 2 included developer seats taken. */
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

/**
 * Billing before the cutover: the payer owns two orgs that both copied their
 * Pro plan, and pays one subscription filed under them alone. `large` has
 * more members, `small` is older.
 */
async function seedPreCutover(
  t: T,
): Promise<{ small: Id<"orgs">; large: Id<"orgs"> }> {
  await seedUser(t, AUTH_ID, "payer@example.com");
  const small = await seedOrg(t, "Small", "pro", 1);
  const large = await seedOrg(t, "Large", "pro", 2);
  await addMember(t, "auth_member", "member@example.com", large);
  await sendEvent(
    t,
    "customer.subscription.created",
    subscription("active", SUBSCRIPTION_ID, 1, { userId: AUTH_ID }),
  );

  return { small: small, large: large };
}

/** Stripe's answer to a seat change: the subscription at its new quantity. */
async function updateLive(
  id: string,
  params: Stripe.SubscriptionUpdateParams,
): Promise<Record<string, unknown>> {
  const next = subscription("active", id, params.items?.[0]?.quantity ?? 1);
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

/** A subscription as Stripe returns it; by default it pays for the payer's org. */
function subscription(
  status: Stripe.Subscription.Status,
  id = SUBSCRIPTION_ID,
  quantity = 1,
  metadata: Record<string, string> = { userId: AUTH_ID, orgId: payerOrgId },
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
          id: ITEM_ID,
          current_period_end: 1_900_000_000,
          quantity: quantity,
          price: { id: "price_seat" },
        },
      ],
    },
  };
}
