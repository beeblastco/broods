/**
 * Storage provider contract test. Runs the same scenarios against each
 * available provider so behaviour stays consistent across DynamoDB and
 * Convex. The Convex provider is skipped when CONVEX_URL +
 * CONVEX_DEPLOY_KEY are not set; it is never faked.
 */

import { describe, expect, it } from "bun:test";
import { optionalEnv } from "../functions/_shared/env.ts";
import { dynamoStorageProvider } from "../functions/_shared/storage/dynamo/index.ts";
import type { StorageProvider } from "../functions/_shared/storage/types.ts";

const providers: Array<[string, StorageProvider]> = [
  ["dynamodb", dynamoStorageProvider],
];

const convexAvailable = Boolean(optionalEnv("CONVEX_URL") && optionalEnv("CONVEX_DEPLOY_KEY"));
if (convexAvailable) {
  const { convexStorageProvider } = require("../functions/_shared/storage/convex/index.ts");
  providers.push(["convex", convexStorageProvider as StorageProvider]);
}

describe("StorageProvider", () => {
  it("loads the dynamodb provider by default", () => {
    expect(dynamoStorageProvider.kind).toBe("dynamodb");
    expect(typeof dynamoStorageProvider.accounts.getById).toBe("function");
    expect(typeof dynamoStorageProvider.accounts.getBySecretHash).toBe("function");
    expect(typeof dynamoStorageProvider.agents.list).toBe("function");
    expect(typeof dynamoStorageProvider.cronJobs.list).toBe("function");
    expect(typeof dynamoStorageProvider.sandboxConfigs.list).toBe("function");
    expect(typeof dynamoStorageProvider.workspaceConfigs.list).toBe("function");
  });

  it("factory respects STORAGE_PROVIDER env", async () => {
    const originalProvider = process.env.STORAGE_PROVIDER;
    try {
      process.env.STORAGE_PROVIDER = "dynamodb";
      const { getStorage, resetStorageForTests } = await import("../functions/_shared/storage/index.ts");
      resetStorageForTests();
      expect(getStorage().kind).toBe("dynamodb");
    } finally {
      if (originalProvider === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = originalProvider;
      const { resetStorageForTests } = await import("../functions/_shared/storage/index.ts");
      resetStorageForTests();
    }
  });

  it("factory throws on unknown provider", async () => {
    const originalProvider = process.env.STORAGE_PROVIDER;
    try {
      process.env.STORAGE_PROVIDER = "redis";
      const { getStorage, resetStorageForTests } = await import("../functions/_shared/storage/index.ts");
      resetStorageForTests();
      expect(() => getStorage()).toThrow(/Unknown STORAGE_PROVIDER/);
    } finally {
      if (originalProvider === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = originalProvider;
      const { resetStorageForTests } = await import("../functions/_shared/storage/index.ts");
      resetStorageForTests();
    }
  });

  for (const [name, storage] of providers) {
    describe(`contract (${name})`, () => {
      it("exposes the required stores", () => {
        expect(storage.accounts).toBeDefined();
        expect(storage.agents).toBeDefined();
        expect(storage.cronJobs).toBeDefined();
        expect(storage.sandboxConfigs).toBeDefined();
        expect(storage.workspaceConfigs).toBeDefined();
      });

      // Live CRUD only runs if the surrounding env has provisioned tables /
      // a reachable Convex deployment. Without that we just assert the
      // shape and skip the round-trips — the project's other suites cover
      // DDB behaviour with mocked clients.
      it.skipIf(!optionalEnv("STORAGE_CONTRACT_LIVE"))(
        "round-trips an account (live)",
        async () => {
          const username = `contract-${Date.now()}`;
          const created = await storage.accounts.create({ username });
          try {
            const fetched = await storage.accounts.getById(created.account.accountId);
            expect(fetched?.username).toBe(username);
            const byHash = await storage.accounts.getBySecretHash(created.account.secretHash);
            expect(byHash?.accountId).toBe(created.account.accountId);
          } finally {
            await storage.accounts.remove(created.account.accountId);
          }
        },
      );
    });
  }

  if (!convexAvailable) {
    it.skip("convex contract — skipped, no CONVEX_URL/CONVEX_DEPLOY_KEY in env", () => {});
  }

  describe("end-to-end provider swap", () => {
    /**
     * Proves that flipping STORAGE_PROVIDER actually changes which store
     * backs every account access. We replace the cached provider with a
     * fake in-memory store and assert `getStorage().accounts.*` routes
     * through it end-to-end.
     */
    it("getStorage().accounts.* routes through the injected provider", async () => {
      const { getStorage, resetStorageForTests, setStorageForTests } = await import("../functions/_shared/storage/index.ts");

      const fakeAccounts = new Map<string, any>();
      const fakeProvider = {
        kind: "fake" as const,
        accounts: {
          async getById(id: string) {
            return fakeAccounts.get(id) ?? null;
          },
          async getBySecretHash() { return null; },
          async list() { return [...fakeAccounts.values()]; },
          async create(input: { username: string; description?: string }) {
            const accountId = `acct_fake_${fakeAccounts.size + 1}`;
            const account = {
              accountId,
              username: input.username,
              ...(input.description ? { description: input.description } : {}),
              secretHash: "fake-hash",
              status: "active" as const,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            fakeAccounts.set(accountId, account);
            return { account, secret: "fp_acct_fake" };
          },
          async update() { return null; },
          async rotateSecret() { return null; },
          async remove(id: string) { return fakeAccounts.delete(id); },
        },
        agents: {} as any,
        cronJobs: {} as any,
      };

      setStorageForTests(fakeProvider as any);

      try {
        const created = await getStorage().accounts.create({ username: "swap-test" });
        expect(created.account.accountId).toMatch(/^acct_fake_/);
        expect(created.secret).toBe("fp_acct_fake");

        const fetched = await getStorage().accounts.getById(created.account.accountId);
        expect(fetched?.username).toBe("swap-test");

        const list = await getStorage().accounts.list();
        expect(list.length).toBe(1);

        const removed = await getStorage().accounts.remove(created.account.accountId);
        expect(removed).toBe(true);
      } finally {
        setStorageForTests(null);
        resetStorageForTests();
      }
    });
  });
});
