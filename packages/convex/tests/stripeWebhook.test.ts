import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  processEvent: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class {
    webhooks = { constructEventAsync: stripeMocks.constructEvent };
  },
}));

vi.mock("@convex-dev/stripe", async (importOriginal) => {
  const module = await importOriginal<typeof import("@convex-dev/stripe")>();

  return { ...module, processEvent: stripeMocks.processEvent };
});

import http from "../http";

describe("Stripe webhook", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("acknowledges customerless invoice events without processing them", async () => {
    stripeMocks.constructEvent.mockResolvedValue({
      type: "invoice.created",
      data: { object: { object: "invoice", customer: null } },
    } as Stripe.Event);

    const route = http.lookup("/stripe/webhook", "POST");
    expect(route).not.toBeNull();

    const [handler] = route!;
    const context = {
      runMutation: vi.fn(),
    } as unknown as GenericActionCtx<GenericDataModel>;
    const request = new Request("https://example.com/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "signature" },
      body: "{}",
    });

    const response = await handler._handler(context, request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(stripeMocks.processEvent).not.toHaveBeenCalled();
  });
});
