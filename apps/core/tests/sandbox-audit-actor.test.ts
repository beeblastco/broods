import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { handler } from "../src/accounts/handler.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import { hashAccountSecret } from "../src/shared/domain/accounts.ts";
import { setStorageForTests } from "../src/shared/storage.ts";
import * as sandboxIndex from "../src/harness/sandbox/index.ts";
import * as sandboxAudit from "../src/shared/convex/sandbox-audit-events.ts";
import type { SandboxAuditActor } from "../src/shared/convex/sandbox-audit-events.ts";
import * as sandboxInstances from "../src/shared/convex/sandbox-instances.ts";

const ACCOUNT_KEY = "bask_actor_test";
const SPOOFED_ACTOR: SandboxAuditActor = {
  source: "dashboard",
  id: "user_someone_else",
  email: "someone@example.com",
};

afterEach(() => {
  delete process.env.SERVICE_AUTH_SECRET;
  mock.restore();
  setStorageForTests(null);
});

describe("sandbox lifecycle audit actor", () => {
  it("names the account key, not the actor a direct caller writes in the body", async () => {
    const audit = stubSuspend();

    const response = await handler(
      suspendRequest(`Bearer ${ACCOUNT_KEY}`, SPOOFED_ACTOR),
    );

    expect(response.status).toBe(200);
    expect(audit.mock.calls[0]?.[0].actor).toEqual({ source: "service" });
  });

  it("keeps the dashboard user the config plane names over the service token", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    const audit = stubSuspend();

    const response = await handler(
      suspendRequest("Bearer service-secret", SPOOFED_ACTOR),
    );

    expect(response.status).toBe(200);
    expect(audit.mock.calls[0]?.[0].actor).toEqual(SPOOFED_ACTOR);
  });
});

function stubSuspend(): ReturnType<
  typeof spyOn<typeof sandboxAudit, "recordSandboxAuditEvent">
> {
  const account = {
    accountId: "acct_test",
    username: "company-a",
    secretHash: hashAccountSecret(ACCOUNT_KEY),
    status: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
  setStorageForTests({
    accounts: {
      getById: async () => account,
      getBySecretHash: async (hash: string) =>
        hash === account.secretHash ? account : null,
    },
    sandboxConfigs: {
      getById: async () => ({
        accountId: "acct_test",
        sandboxId: "sbx_1",
        name: "box",
        config: { provider: "daytona" },
      }),
    },
  } as never);
  spyOn(sandboxInstances, "sandboxInstanceIsControllable").mockResolvedValue(
    true,
  );
  spyOn(sandboxInstances, "setSandboxInstanceStatus").mockResolvedValue(true);
  spyOn(sandboxIndex, "createSandboxExecutor").mockReturnValue({
    run: async () => {
      throw new Error("not called");
    },
    suspend: async () => undefined,
  });

  return spyOn(sandboxAudit, "recordSandboxAuditEvent").mockResolvedValue(
    undefined,
  );
}

function suspendRequest(authorization: string, actor: unknown): CoreRequest {
  return {
    method: "POST",
    path: "/v1/sandboxes/sbx_1/suspend",
    search: "",
    query: new URLSearchParams(),
    headers: { authorization: authorization, "x-account-id": "acct_test" },
    body: JSON.stringify({ reservationKey: "res_1", actor: actor }),
    clientIp: "127.0.0.1",
  };
}
