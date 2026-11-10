import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { handler } from "../src/accounts/handler.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import { setStorageForTests } from "../src/shared/storage.ts";
import * as sandboxInstances from "../src/shared/convex/sandbox-instances.ts";

const ACCOUNT = {
  accountId: "acct_test",
  username: "company-a",
  secretHash: "hash",
  status: "active",
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
};

afterEach(() => {
  delete process.env.ADMIN_ACCOUNT_SECRET;
  delete process.env.SERVICE_AUTH_SECRET;
  mock.restore();
  setStorageForTests(null);
});

describe("account API error status", () => {
  it("answers an outage with a generic 500, not a 400 with its message", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setStorageForTests({
      accounts: { getById: async () => ACCOUNT },
      sandboxConfigs: {
        getById: async () => ({
          accountId: "acct_test",
          sandboxId: "sbx_1",
          config: { provider: "daytona" },
        }),
      },
    } as never);
    spyOn(sandboxInstances, "sandboxInstanceIsControllable").mockRejectedValue(
      new Error("connect ECONNREFUSED convex.internal:3210"),
    );

    const response = await handler(
      request("/v1/sandboxes/sbx_1/suspend", "Bearer service-secret", {
        reservationKey: "res_1",
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("convex.internal");
  });

  it("keeps 400 for a request the caller can fix", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    setStorageForTests({ accounts: {} } as never);

    const response = await handler(
      request("/v1/accounts", "Bearer admin-secret", { username: "" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "username must be a non-empty string" },
    });
  });
});

function request(
  path: string,
  authorization: string,
  body: unknown,
): CoreRequest {
  return {
    method: "POST",
    path: path,
    search: "",
    query: new URLSearchParams(),
    headers: { authorization: authorization, "x-account-id": "acct_test" },
    body: JSON.stringify(body),
    clientIp: "127.0.0.1",
  };
}
