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
  // processEvent fetches the latest invoice on checkout completion.
  retrieveSubscription: vi.fn().mockResolvedValue({ latest_invoice: null }),
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
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

/** POST a signed Stripe event to the webhook route and require a 200. */
async function sendEvent(
  t: T,
  type: string,
  object: Record<string, unknown>,
): Promise<void> {
  const payload = JSON.stringify({
    id: `evt_${type}`,
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
  const response = await t.fetch("/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });

  expect(response.status).toBe(200);
}

function subscription(
  status: Stripe.Subscription.Status,
): Record<string, unknown> {
  return {
    id: SUBSCRIPTION_ID,
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
