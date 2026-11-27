/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { AUTH_FAILURE_BUCKETS, authFailureKey } from "../config/routes/shared";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "bask_test-auth-failures-secret";
const SOURCE = "198.51.100.25";

type T = TestConvex<typeof schema>;

beforeEach((): void => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("rotating invalid tokens from one source is blocked like one token", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  for (let i = 0; i < 19; i += 1) {
    expect(await listAgents(t, SOURCE, `invalid-rotated-${i}`)).toBe(401);
  }
  expect(await listAgents(t, SOURCE, "invalid-rotated-19")).toBe(429);
  for (let i = 20; i < 60; i += 1) {
    expect(await listAgents(t, SOURCE, `invalid-rotated-${i}`)).toBe(429);
  }
  const rows = await t.run(async (ctx) =>
    ctx.db.query("configHttpAuthFailures").collect(),
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]?.count).toBe(20);
  expect(rows[0]?.blockedUntil).toBeGreaterThan(Date.now());
});

test("a blocked shared address still authenticates a valid key", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx): Promise<void> => {
    const orgId = await ctx.db.insert("orgs", {
      name: "shared",
      slug: "shared",
      ownerAuthId: "auth_shared",
      plan: "free",
      createdAt: Date.now(),
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "shared",
      secretHash: await sha256Hex(ACCOUNT_SECRET),
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  for (let i = 0; i < 20; i += 1) {
    await listAgents(t, SOURCE, `invalid-${i}`);
  }

  expect(await listAgents(t, SOURCE, "invalid-again")).toBe(429);
  expect(await listAgents(t, SOURCE, ACCOUNT_SECRET)).toBe(200);
  expect(await listAgents(t, "203.0.113.80", "invalid-elsewhere")).toBe(401);
});

test("a source is the hop the edge appended, and an IPv6 /64 is one source", async (): Promise<void> => {
  const key = (forwarded: string): Promise<string> =>
    authFailureKey(
      new Request("https://config.test/v1/agents", {
        headers: {
          "x-forwarded-for": forwarded,
          Authorization: `Bearer ${crypto.randomUUID()}`,
        },
      }),
    );

  expect(await key(`203.0.113.9, ${SOURCE}`)).toBe(await key(SOURCE));
  expect(await key("2001:db8:1:2::1")).toBe(
    await key("2001:DB8:1:2:ffff:ffff:ffff:ffff"),
  );
  expect(await key("2001:db8:1:2::1")).not.toBe(await key("2001:db8:1:3::1"));
});

test("a source's bucket depends on the server secret", async (): Promise<void> => {
  const sources = Array.from({ length: 16 }, (_, i) => `192.0.2.${i}`);
  const buckets = (): Promise<string[]> =>
    Promise.all(
      sources.map((source) =>
        authFailureKey(
          new Request("https://config.test/v1/agents", {
            headers: { "x-forwarded-for": source },
          }),
        ),
      ),
    );

  const first = await buckets();
  vi.stubEnv("SERVICE_AUTH_SECRET", "another-service-secret");

  expect(await buckets()).not.toEqual(first);
});

test("failed-auth rows stay bounded however many sources fail", async (): Promise<void> => {
  const keys = new Set(
    await Promise.all(
      Array.from(
        { length: AUTH_FAILURE_BUCKETS * 4 },
        (_, i): Promise<string> =>
          authFailureKey(
            new Request("https://config.test/v1/agents", {
              headers: {
                "x-forwarded-for": `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`,
              },
            }),
          ),
      ),
    ),
  );
  expect(keys.size).toBeLessThanOrEqual(AUTH_FAILURE_BUCKETS);

  // A full table is the most a daily prune ever deletes, in bounded batches.
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const now = Date.now();
  const stale = now - 25 * 60 * 60 * 1000;
  await t.run(async (ctx): Promise<void> => {
    for (const key of keys) {
      await ctx.db.insert("configHttpAuthFailures", {
        key: key,
        windowStart: stale,
        count: 1,
        updatedAt: stale,
      });
    }
    await ctx.db.insert("configHttpAuthFailures", {
      key: "fresh",
      windowStart: now,
      count: 1,
      updatedAt: now,
    });
  });

  expect(
    await t.mutation(internal.config.authFailures.pruneExpired, {
      now: now,
      batchSize: 500,
    }),
  ).toBe(500);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const left = await t.run(async (ctx) =>
    ctx.db.query("configHttpAuthFailures").collect(),
  );
  expect(left.map((row) => row.key)).toEqual(["fresh"]);
});

async function listAgents(
  t: T,
  forwardedFor: string,
  token: string,
): Promise<number> {
  const response = await t.fetch("/v1/agents", {
    method: "GET",
    headers: {
      "x-forwarded-for": forwardedFor,
      Authorization: `Bearer ${token}`,
    },
  });

  return response.status;
}
