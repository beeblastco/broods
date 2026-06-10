/**
 * Bearer auth tests: admin secret, the cherry-coke service-token path, and
 * account-secret hash lookup.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { hashAccountSecret, type AccountRecord } from "../functions/_shared/storage/accounts.ts";
import { resetStorageForTests, setStorageForTests, type StorageProvider } from "../functions/_shared/storage/index.ts";
import { extractBearerToken, resolveBearerAuth } from "../functions/_shared/auth.ts";

const ACCOUNT: AccountRecord = {
  accountId: "acct_1",
  username: "tester",
  secretHash: hashAccountSecret("fp_acct_known-secret"),
  status: "active",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

let accountsById: Record<string, AccountRecord>;
let accountsBySecretHash: Record<string, AccountRecord>;

beforeEach(() => {
  process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
  process.env.SERVICE_AUTH_SECRET = "service-secret";
  accountsById = { [ACCOUNT.accountId]: ACCOUNT };
  accountsBySecretHash = { [ACCOUNT.secretHash]: ACCOUNT };
  setStorageForTests({
    accounts: {
      getById: async (accountId: string) => accountsById[accountId] ?? null,
      getBySecretHash: async (secretHash: string) => accountsBySecretHash[secretHash] ?? null,
    },
  } as unknown as StorageProvider);
});

afterEach(() => {
  resetStorageForTests();
});

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBe("abc");
  });

  it("rejects malformed headers", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer a b")).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
  });
});

describe("resolveBearerAuth", () => {
  it("resolves the admin secret", async () => {
    const auth = await resolveBearerAuth({ authorization: "Bearer admin-secret" });
    expect(auth).toEqual({ kind: "admin" });
  });

  it("resolves an account by secret hash", async () => {
    const auth = await resolveBearerAuth({ authorization: "Bearer fp_acct_known-secret" });
    expect(auth).toMatchObject({ kind: "account", account: { accountId: "acct_1" } });
  });

  it("rejects unknown tokens", async () => {
    expect(await resolveBearerAuth({ authorization: "Bearer nope" })).toBeNull();
    expect(await resolveBearerAuth({})).toBeNull();
  });

  it("resolves the service token only with a valid X-Account-Id header", async () => {
    const auth = await resolveBearerAuth({
      authorization: "Bearer service-secret",
      "x-account-id": "acct_1",
    });
    expect(auth).toMatchObject({ kind: "account", viaServiceToken: true, account: { accountId: "acct_1" } });

    expect(await resolveBearerAuth({ authorization: "Bearer service-secret" })).toBeNull();
    expect(await resolveBearerAuth({
      authorization: "Bearer service-secret",
      "x-account-id": "acct_missing",
    })).toBeNull();
  });

  it("rejects the service token for disabled accounts", async () => {
    accountsById.acct_1 = { ...ACCOUNT, status: "disabled" };
    expect(await resolveBearerAuth({
      authorization: "Bearer service-secret",
      "x-account-id": "acct_1",
    })).toBeNull();
  });

  it("rejects disabled accounts on the secret-hash path", async () => {
    accountsBySecretHash[ACCOUNT.secretHash] = { ...ACCOUNT, status: "disabled" };
    expect(await resolveBearerAuth({ authorization: "Bearer fp_acct_known-secret" })).toBeNull();
  });
});
