import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { handler } from "../../../../apps/core/src/accounts/handler.ts";
import * as planLimits from "../../../../apps/core/src/harness/plan-limits.ts";
import * as sandboxIndex from "../../../../apps/core/src/harness/sandbox/index.ts";
import * as instanceStore from "../../../../apps/core/src/harness/sandbox/instance-store.ts";
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

const HEADERS = {
  authorization: "Bearer service-secret",
  "x-account-id": "acct_test",
};
const originalServiceSecret = process.env.SERVICE_AUTH_SECRET;
let spies: Spy[] = [];

function request(path: string, body: unknown): CoreRequest {
  return {
    method: "POST",
    path: path,
    search: "",
    query: new URLSearchParams(),
    headers: HEADERS,
    body: JSON.stringify(body),
    cookies: [],
    clientIp: "127.0.0.1",
  };
}

function useRecord(config: Record<string, unknown>): void {
  setStorageForTests({
    accounts: {
      getById: async (): Promise<unknown> => ({
        accountId: "acct_test",
        status: "active",
        config: {},
      }),
    },
    sandboxConfigs: {
      getById: async (): Promise<unknown> => ({
        accountId: "acct_test",
        sandboxId: "sbx_1",
        name: "box",
        config: config,
      }),
    },
  } as unknown as StorageArg);
}

function useExecutor(executor: Record<string, unknown>): void {
  spies.push(
    spyOn(sandboxIndex, "createSandboxExecutor").mockReturnValue(
      executor as unknown as Executor,
    ),
  );
}

beforeEach((): void => {
  process.env.SERVICE_AUTH_SECRET = "service-secret";
  spies = [
    spyOn(sandboxInstances, "sandboxInstanceIsControllable").mockResolvedValue(
      true,
    ),
    spyOn(sandboxInstances, "setSandboxInstanceStatus").mockResolvedValue(true),
    spyOn(sandboxAudit, "recordSandboxAuditEvent").mockResolvedValue(undefined),
    spyOn(planLimits, "assertSandboxBudget").mockResolvedValue(undefined),
  ];
});

afterEach((): void => {
  for (const spy of spies) spy.mockRestore();
  if (originalServiceSecret === undefined)
    delete process.env.SERVICE_AUTH_SECRET;
  else process.env.SERVICE_AUTH_SECRET = originalServiceSecret;
  setStorageForTests(null);
  resetStorageForTests();
});

describe("suspend and resume", () => {
  test.each([
    ["suspend", "suspended", "ext-1"],
    ["resume", "running", "ext-1"],
    ["suspend", "suspended", null],
    ["resume", "running", null],
  ])(
    "%s answers %s (external id %s)",
    async (
      action: string,
      status: string,
      externalId: string | null,
    ): Promise<void> => {
      useRecord({ provider: "daytona" });
      useExecutor({
        suspend: async (): Promise<void> => {},
        resume: async (): Promise<void> => {},
      });
      spies.push(
        spyOn(instanceStore, "getSandboxExternalId").mockResolvedValue(
          externalId,
        ),
      );

      const response = await handler(
        request(`/v1/sandboxes/sbx_1/${action}`, { reservationKey: "res_1" }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: status });
    },
  );

  test.each(["suspend", "resume"])(
    "%s refuses a provider without it",
    async (action: string): Promise<void> => {
      useRecord({ provider: "daytona" });
      useExecutor({});

      const response = await handler(
        request(`/v1/sandboxes/sbx_1/${action}`, { reservationKey: "res_1" }),
      );

      expect(response.status).toBe(409);
    },
  );
});

describe("the base image a lambda snapshot records", () => {
  test.each([
    [{ provider: "lambda", image: "python" }, null, "python"],
    [{ provider: "lambda" }, null, "default"],
    [{ provider: "lambda", snapshot: "pinned" }, null, "default"],
    [
      { provider: "lambda", snapshot: "pinned" },
      { accountId: "acct_test", baseImage: "node" },
      "node",
    ],
    [
      { provider: "lambda", snapshot: "pinned" },
      { accountId: "acct_other", baseImage: "node" },
      "default",
    ],
  ])(
    "%j",
    async (
      config: Record<string, unknown>,
      pinned: unknown,
      baseImage: string,
    ): Promise<void> => {
      useRecord(config);
      useExecutor({
        snapshot: async (): Promise<unknown> => ({ snapshotId: "snap_1" }),
      });
      const upsert = spyOn(
        sandboxSnapshots,
        "upsertSandboxSnapshot",
      ).mockResolvedValue(undefined as never);
      spies.push(
        upsert,
        spyOn(sandboxSnapshots, "findSandboxSnapshot").mockResolvedValue(
          pinned as never,
        ),
      );

      const response = await handler(
        request("/v1/sandboxes/sbx_1/snapshot", {
          reservationKey: "res_1",
          name: "base",
        }),
      );

      expect(response.status).toBe(200);
      expect(upsert.mock.calls[0]?.[0]).toMatchObject({ baseImage: baseImage });
    },
  );
});
