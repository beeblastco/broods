/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

interface FakeSubscription {
  id: string;
  metadata: Record<string, string>;
}

const stripeApi = vi.hoisted(() => ({
  subscriptions: [] as Array<FakeSubscription>,
  update: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("stripe", () => ({
  default: class {
    subscriptions = {
      list: (): AsyncIterable<FakeSubscription> => ({
        [Symbol.asyncIterator]:
          async function* (): AsyncGenerator<FakeSubscription> {
            yield* stripeApi.subscriptions;
          },
      }),
      update: stripeApi.update,
    };
  },
}));

const modules = import.meta.glob("../**/*.ts");

describe("backfillSubscriptionUserIds", () => {
  test("dry run by default: reports the subscriptions missing userId and writes nothing", async () => {
    const t = convexTest(schema, modules);

    const result = await t.action(
      internal.stripe.backfillSubscriptionUserIds,
      {},
    );

    expect(result).toEqual({
      dryRun: true,
      scanned: 3,
      updated: ["sub_old"],
    });
    expect(stripeApi.update).not.toHaveBeenCalled();
  });

  test("with dryRun false, copies authId to userId only where it is missing", async () => {
    const t = convexTest(schema, modules);

    const result = await t.action(internal.stripe.backfillSubscriptionUserIds, {
      dryRun: false,
    });

    expect(result.updated).toEqual(["sub_old"]);
    expect(stripeApi.update).toHaveBeenCalledTimes(1);
    expect(stripeApi.update).toHaveBeenCalledWith("sub_old", {
      metadata: { userId: "auth_old" },
    });
  });
});

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_backfill");
  stripeApi.update.mockClear();
  stripeApi.subscriptions = [
    { id: "sub_old", metadata: { authId: "auth_old" } },
    { id: "sub_new", metadata: { userId: "auth_new" } },
    { id: "sub_foreign", metadata: {} },
  ];
});

afterEach(() => {
  vi.unstubAllEnvs();
});
