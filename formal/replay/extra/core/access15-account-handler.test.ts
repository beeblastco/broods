import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as sandboxRules from "../../../../packages/convex/model/sandboxRules.ts";
import { handler } from "../../../../apps/core/src/accounts/handler.ts";
import * as planLimits from "../../../../apps/core/src/harness/plan-limits.ts";
import * as sandboxIndex from "../../../../apps/core/src/harness/sandbox/index.ts";
import * as instanceStore from "../../../../apps/core/src/harness/sandbox/instance-store.ts";
import * as microvm from "../../../../apps/core/src/harness/sandbox/microvm-executor.ts";
import * as auth from "../../../../apps/core/src/shared/auth.ts";
import * as sandboxAudit from "../../../../apps/core/src/shared/convex/sandbox-audit-events.ts";
import * as sandboxInstances from "../../../../apps/core/src/shared/convex/sandbox-instances.ts";
import * as sandboxSnapshots from "../../../../apps/core/src/shared/convex/sandbox-snapshots.ts";
import type { CoreRequest } from "../../../../apps/core/src/shared/http.ts";
import {
  resetStorageForTests,
  setStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";

type Executor = ReturnType<typeof sandboxIndex.createSandboxExecutor>;
type StorageArg = Parameters<typeof setStorageForTests>[0];
type Spy = { mockRestore: () => void };
type Body = Record<string, unknown>;

const SERVICE_HEADERS = {
  authorization: "Bearer service-secret",
  "x-account-id": "acct_test",
};
const ADMIN_HEADERS = { authorization: "Bearer admin-secret" };
const ACCOUNT = { accountId: "acct_test", status: "active", config: {} };
const originalEnv = {
  service: process.env.SERVICE_AUTH_SECRET,
  admin: process.env.ADMIN_ACCOUNT_SECRET,
};
let spies: Spy[] = [];

function request(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = SERVICE_HEADERS,
): CoreRequest {
  return {
    method: method,
    path: path,
    search: "",
    query: new URLSearchParams(),
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cookies: [],
    clientIp: "127.0.0.1",
  };
}

function lifecycle(action: string, body: Body = {}): CoreRequest {
  return request("POST", `/v1/sandboxes/sbx_1/${action}`, {
    reservationKey: "res_1",
    ...body,
  });
}

function useStorage(overrides: Record<string, unknown> = {}): void {
  setStorageForTests({
    accounts: { getById: async (): Promise<unknown> => ACCOUNT },
    sandboxConfigs: {
      getById: async (): Promise<unknown> => ({
        accountId: "acct_test",
        sandboxId: "sbx_1",
        name: "box",
        config: { provider: "lambda" },
      }),
    },
    ...overrides,
  } as unknown as StorageArg);
}

function useExecutor(executor: Record<string, unknown>): void {
  spies.push(
    spyOn(sandboxIndex, "createSandboxExecutor").mockReturnValue(
      executor as unknown as Executor,
    ),
  );
}

let audits: Array<Record<string, unknown>> = [];

beforeEach((): void => {
  process.env.SERVICE_AUTH_SECRET = "service-secret";
  process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
  audits = [];
  spies = [
    spyOn(sandboxInstances, "sandboxInstanceIsControllable").mockResolvedValue(
      true,
    ),
    spyOn(sandboxInstances, "setSandboxInstanceStatus").mockResolvedValue(true),
    spyOn(sandboxAudit, "recordSandboxAuditEvent").mockImplementation(
      async (event): Promise<void> => {
        audits.push(event as unknown as Record<string, unknown>);
      },
    ),
    spyOn(planLimits, "assertSandboxBudget").mockResolvedValue(undefined),
  ];
  useStorage();
});

afterEach((): void => {
  for (const spy of spies) spy.mockRestore();
  if (originalEnv.service === undefined) delete process.env.SERVICE_AUTH_SECRET;
  else process.env.SERVICE_AUTH_SECRET = originalEnv.service;
  if (originalEnv.admin === undefined) delete process.env.ADMIN_ACCOUNT_SECRET;
  else process.env.ADMIN_ACCOUNT_SECRET = originalEnv.admin;
  setStorageForTests(null);
  resetStorageForTests();
});

describe("handleAccountRequest", (): void => {
  test("refuses the root path without auth", async (): Promise<void> => {
    const response = await handler(request("GET", "/", undefined, {}));

    expect(response.status).toBe(401);
  });

  test("answers an unknown account delete with 404", async (): Promise<void> => {
    useStorage({
      accounts: {
        getById: async (): Promise<unknown> => null,
      },
    });
    const response = await handler(
      request("DELETE", "/v1/accounts/acct_gone", undefined, ADMIN_HEADERS),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { message: "Account not found" },
    });
  });

  test("answers 401 when a non-account credential deletes the account", async (): Promise<void> => {
    spies.push(
      spyOn(auth, "resolveBearerAuth").mockResolvedValue({
        kind: "agent",
      } as unknown as auth.AuthContext),
    );
    const response = await handler(request("DELETE", "/v1/account", undefined));

    expect(response.status).toBe(401);
  });

  test("refuses the admin key on the account self-delete", async (): Promise<void> => {
    const response = await handler(
      request("DELETE", "/v1/account", undefined, ADMIN_HEADERS),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "Admin must use account-specific endpoints" },
    });
  });

  test("answers 404 when disabling the account finds nobody", async (): Promise<void> => {
    useStorage({
      accounts: {
        getById: async (): Promise<unknown> => ACCOUNT,
        disable: async (): Promise<unknown> => null,
      },
    });
    const response = await handler(
      request("DELETE", "/v1/accounts/acct_test", undefined, ADMIN_HEADERS),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "account_not_found" },
    });
  });
});

describe("handleMcpServiceRoute", (): void => {
  test("hands a service-token call to the rpc", async (): Promise<void> => {
    const response = await handler(
      request("POST", "/v1/mcp-service/rpc", { method: "bogus" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "method must be tools/list or tools/call" },
    });
  });

  test("refuses a caller that is not the service token", async (): Promise<void> => {
    const response = await handler(
      request("POST", "/v1/mcp-service/rpc", {}, ADMIN_HEADERS),
    );

    expect(response.status).toBe(403);
  });
});

describe("handleSandboxLifecycleRoute", (): void => {
  test("allows POST only", async (): Promise<void> => {
    const response = await handler(
      request("GET", "/v1/sandboxes/sbx_1/suspend", undefined),
    );

    expect(response.status).toBe(405);
  });

  test("answers 404 for a sandbox that does not exist", async (): Promise<void> => {
    useStorage({
      sandboxConfigs: { getById: async (): Promise<unknown> => null },
    });
    const response = await handler(lifecycle("suspend"));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { message: "Sandbox not found" },
    });
  });

  test("answers 401 to a credential that is not an account", async (): Promise<void> => {
    spies.push(
      spyOn(auth, "resolveBearerAuth").mockResolvedValue({
        kind: "deployment",
      } as unknown as auth.AuthContext),
    );
    const response = await handler(lifecycle("suspend"));

    expect(response.status).toBe(401);
  });
});

describe("handleSandboxLifecycle", (): void => {
  test("lets an unexpected budget failure through as an error", async (): Promise<void> => {
    spies.push(
      spyOn(planLimits, "assertSandboxBudget").mockRejectedValue(
        new Error("billing store down"),
      ),
    );
    useExecutor({});
    const response = await handler(lifecycle("exec", { code: "echo 1" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "billing store down" },
    });
  });

  test("answers 400 for a config check that fails unexpectedly", async (): Promise<void> => {
    spies.push(
      spyOn(sandboxRules, "assertNoRetiredImageOptions").mockImplementation(
        (): void => {
          throw new Error("rule table unreadable");
        },
      ),
    );
    const response = await handler(lifecycle("suspend"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "Invalid sandbox configuration" },
    });
  });

  test("records the actor a dashboard call names", async (): Promise<void> => {
    useExecutor({ suspend: async (): Promise<void> => {} });
    spies.push(
      spyOn(instanceStore, "getSandboxExternalId").mockResolvedValue(null),
    );
    await handler(
      lifecycle("suspend", {
        actor: {
          source: "dashboard",
          id: " user_1 ",
          email: "a@example.com",
          name: " Ada ",
        },
      }),
    );

    expect(audits[0]?.actor).toEqual({
      source: "dashboard",
      id: "user_1",
      email: "a@example.com",
      name: "Ada",
    });
  });
});

describe("execSandbox", (): void => {
  test.each([
    ["is missing", "   ", "code is required"],
    [
      "is too long",
      "x".repeat(20_001),
      "code must be 20000 characters or less",
    ],
  ])(
    "refuses code that %s",
    async (_name: string, code: string, message: string): Promise<void> => {
      useExecutor({});
      const response = await handler(lifecycle("exec", { code: code }));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: message },
      });
      expect(audits[0]).toMatchObject({
        result: "error",
        errorMessage: message,
      });
    },
  );

  test("runs with a timeout inside the provider's bounds", async (): Promise<void> => {
    const runs: Array<Record<string, unknown>> = [];
    useExecutor({
      run: async (input: Record<string, unknown>): Promise<unknown> => {
        runs.push(input);

        return {
          ok: true,
          runtime: "bash",
          exitCode: 0,
          stdout: "1\n",
          stderr: "",
          durationMs: 3,
          provider: "lambda",
        };
      },
    });
    const response = await handler(
      lifecycle("exec", { code: "echo 1", timeoutSeconds: 7 }),
    );

    expect(response.status).toBe(200);
    expect(runs[0]).toMatchObject({ timeoutSeconds: 7 });
  });
});

describe("openSandboxTerminal", (): void => {
  test("answers 404 when the reservation has no instance", async (): Promise<void> => {
    useExecutor({});
    spies.push(
      spyOn(instanceStore, "getSandboxExternalId").mockResolvedValue(null),
    );
    const response = await handler(lifecycle("terminal"));

    expect(response.status).toBe(404);
    expect(audits[0]).toMatchObject({ result: "error" });
  });

  test("resumes a suspended guest before opening the shell", async (): Promise<void> => {
    const resumed: unknown[] = [];
    useExecutor({
      getInstanceInfo: async (): Promise<unknown> => ({ state: "suspended" }),
      resume: async (ref: unknown): Promise<void> => {
        resumed.push(ref);
      },
    });
    spies.push(
      spyOn(instanceStore, "getSandboxExternalId").mockResolvedValue("ext-1"),
      spyOn(microvm, "microvmShellConnection").mockRejectedValue(
        new Error("no shell ingress"),
      ),
    );
    const response = await handler(lifecycle("terminal"));

    expect(resumed).toEqual([{ reservationKey: "res_1" }]);
    expect(response.status).toBe(409);
  });
});

describe("refreshSandboxStatus", (): void => {
  test("refuses a provider that cannot report status", async (): Promise<void> => {
    useExecutor({});
    const response = await handler(lifecycle("refresh"));

    expect(response.status).toBe(409);
  });

  test.each([
    ["is gone", null],
    ["is terminating", { state: "terminating" }],
  ])(
    "forgets an instance that %s",
    async (_name: string, info: unknown): Promise<void> => {
      useExecutor({ getInstanceInfo: async (): Promise<unknown> => info });
      const removed = spyOn(
        sandboxInstances,
        "removeSandboxInstance",
      ).mockResolvedValue(undefined as never);
      spies.push(removed);
      const response = await handler(lifecycle("refresh"));

      expect(await response.json()).toEqual({ status: "terminated" });
      expect(removed.mock.calls[0]).toEqual(["acct_test", "res_1"]);
    },
  );

  test("audits a state change, and an unknown state as an error", async (): Promise<void> => {
    useExecutor({
      getInstanceInfo: async (): Promise<unknown> => ({
        state: "unknown",
        externalId: "ext-9",
      }),
    });
    const response = await handler(lifecycle("refresh"));

    expect(await response.json()).toEqual({
      status: "error",
      externalId: "ext-9",
    });
    expect(audits[0]).toMatchObject({
      result: "error",
      status: "error",
      errorMessage: "provider reported an unrecognised state",
    });
  });
});

describe("snapshotSandbox", (): void => {
  test("refuses a provider without snapshots", async (): Promise<void> => {
    useExecutor({});
    const response = await handler(lifecycle("snapshot", { name: "base" }));

    expect(response.status).toBe(409);
  });

  test("needs a name", async (): Promise<void> => {
    useExecutor({
      snapshot: async (): Promise<unknown> => ({ snapshotId: "snap_1" }),
    });
    const response = await handler(lifecycle("snapshot", { name: "  " }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "name is required" },
    });
  });

  test("does not hide a store failure behind a client error", async (): Promise<void> => {
    useExecutor({
      snapshot: async (): Promise<unknown> => ({ snapshotId: "snap_1" }),
    });
    spies.push(
      spyOn(sandboxSnapshots, "upsertSandboxSnapshot").mockRejectedValue(
        new Error("snapshot store down"),
      ),
    );
    const response = await handler(lifecycle("snapshot", { name: "base" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "snapshot store down" },
    });
  });
});

describe("terminateSandbox", (): void => {
  test("refuses a provider that cannot release", async (): Promise<void> => {
    useExecutor({});
    const response = await handler(lifecycle("terminate"));

    expect(response.status).toBe(409);
  });
});
