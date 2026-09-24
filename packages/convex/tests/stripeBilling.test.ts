/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
// The package exports no schema or test helper, so load the component's own
// build straight from disk to register it.
import stripeSchema from "../node_modules/@convex-dev/stripe/dist/component/schema.js";
import schema from "../schema";

const AUTH_ID = "auth_payer";
const CUSTOMER_ID = "cus_payer";
const SUBSCRIPTION_ID = "sub_payer";
const WEBHOOK_SECRET = "whsec_billing_test";

vi.mock("../auth", () => ({
  authKit: {
    getAuthUser: async () => ({ id: AUTH_ID, email: null }),
    registerRoutes: () => undefined,
  },
}));

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
});

describe("createCheckoutSession", () => {
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
});

function billingTest(): T {
  const t = convexTest(schema, modules);
  t.registerComponent("stripe", stripeSchema, stripeModules);

  return t;
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
