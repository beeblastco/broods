/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components } from "../_generated/api";
// The package exports no schema or test helper, so load the component's own
// build straight from disk to register it.
import stripeSchema from "../node_modules/@convex-dev/stripe/dist/component/schema.js";
import schema from "../schema";
import { stripeClient } from "../stripe";

const AUTH_ID = "auth_payer";
const CUSTOMER_ID = "cus_payer";
const SUBSCRIPTION_ID = "sub_payer";
const WEBHOOK_SECRET = "whsec_billing_test";

const stripeCalls = vi.hoisted(() => ({
  customers: vi.fn(),
  // What Stripe holds now, by subscription id. The webhook reads it back.
  live: new Map<string, Record<string, unknown>>(),
  retrieveSubscription: vi.fn(),
  subscriptions: vi.fn(),
}));

vi.mock("../auth", () => ({
  authKit: {
    getAuthUser: async () => ({ id: AUTH_ID, email: "payer@example.com" }),
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

  test("a redelivered event is acknowledged and not applied again", async () => {
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
    expect(stripeCalls.retrieveSubscription).not.toHaveBeenCalled();
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

describe("payment link checkout", () => {
  test("stamps the user on the subscription and customer", async () => {
    const t = billingTest();
    await seedPayer(t);

    await sendEvent(t, "checkout.session.completed", checkout(AUTH_ID));

    expect(stripeCalls.subscriptions).toHaveBeenCalledWith(SUBSCRIPTION_ID, {
      metadata: { userId: AUTH_ID },
    });
    expect(stripeCalls.customers).toHaveBeenCalledWith(CUSTOMER_ID, {
      metadata: { userId: AUTH_ID },
    });
    const customer = await t.query(
      components.stripe.public.getCustomerByUserId,
      { userId: AUTH_ID },
    );
    expect(customer?.stripeCustomerId).toBe(CUSTOMER_ID);
  });

  test("a paused trial opens the portal, not a second checkout", async () => {
    const t = billingTest();
    await seedPayer(t);
    // The link creates the customer with no userId; checkout links it.
    await sendEvent(t, "customer.created", {
      id: CUSTOMER_ID,
      object: "customer",
      email: "payer@example.com",
      metadata: {},
    });
    await sendEvent(t, "checkout.session.completed", checkout(AUTH_ID));
    await sendEvent(t, "customer.subscription.updated", subscription("paused"));
    const portalSession = vi
      .spyOn(stripeClient, "createCustomerPortalSession")
      .mockResolvedValue({ url: "https://portal.test" });

    await expect(
      t.action(api.stripe.createCheckoutSession, {
        successUrl: "http://localhost:3000/ok",
        cancelUrl: "http://localhost:3000/cancel",
      }),
    ).rejects.toThrow("Already subscribed");
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

  test("ignores a client_reference_id that is no user", async () => {
    const t = billingTest();
    await seedPayer(t);

    await sendEvent(t, "checkout.session.completed", checkout("auth_nobody"));

    expect(stripeCalls.subscriptions).not.toHaveBeenCalled();
    expect(stripeCalls.customers).not.toHaveBeenCalled();
  });
});

describe("createCheckoutSession", () => {
  test("returns the payment link for the user when one is set", async () => {
    vi.stubEnv("STRIPE_PRO_PAYMENT_LINK", "https://buy.stripe.com/test_pro");
    const t = billingTest();
    await seedPayer(t);

    const { url } = await t.action(api.stripe.createCheckoutSession, {
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/cancel",
    });

    expect(url).toBe(
      `https://buy.stripe.com/test_pro?client_reference_id=${AUTH_ID}&prefilled_email=payer%40example.com`,
    );
  });

  test("refuses a customer who already has a live subscription", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(t, "customer.created", {
      id: CUSTOMER_ID,
      object: "customer",
      email: "payer@example.com",
      metadata: { userId: AUTH_ID },
    });
    await sendEvent(t, "customer.subscription.created", subscription("active"));

    await expect(
      t.action(api.stripe.createCheckoutSession, {
        successUrl: "http://localhost:3000/ok",
        cancelUrl: "http://localhost:3000/cancel",
      }),
    ).rejects.toThrow("Already subscribed");
  });
});

describe("getBillingInfo", () => {
  test("returns a past_due subscription so the dashboard offers the portal", async () => {
    const t = billingTest();
    await seedPayer(t);
    await sendEvent(
      t,
      "customer.subscription.created",
      subscription("past_due"),
    );

    const info = await t.query(api.stripe.getBillingInfo, {});

    expect(info?.status).toBe("past_due");
    expect(await plans(t)).toEqual({ user: "free", org: "free" });
  });

  test("returns null once the subscription is canceled", async () => {
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
    const org = await ctx.db
      .query("orgs")
      .withIndex("by_ownerAuthId", (q) => q.eq("ownerAuthId", AUTH_ID))
      .unique();

    return { user: user?.plan ?? "missing", org: org?.plan ?? "missing" };
  });
}

async function seedPayer(t: T): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "payer@example.com",
      name: "Payer",
      plan: "free",
    });
    await ctx.db.insert("orgs", {
      name: "Payer Org",
      slug: "payer-org",
      ownerAuthId: AUTH_ID,
      plan: "free",
      createdAt: Date.now(),
    });
  });
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

function subscription(
  status: Stripe.Subscription.Status,
  id = SUBSCRIPTION_ID,
): Record<string, unknown> {
  return {
    id: id,
    object: "subscription",
    customer: CUSTOMER_ID,
    status: status,
    cancel_at_period_end: false,
    cancel_at: null,
    metadata: { userId: AUTH_ID },
    items: {
      data: [
        {
          current_period_end: 1_900_000_000,
          quantity: 1,
          price: { id: "price_pro" },
        },
      ],
    },
  };
}
