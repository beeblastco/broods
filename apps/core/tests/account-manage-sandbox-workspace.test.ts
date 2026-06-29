/**
 * Account-management sandbox/workspace CRUD endpoint tests.
 * Drive the /accounts/me/{sandboxes,workspaces} routes through the HTTP handler
 * with an in-memory store backed by the real normalizers, so routing, secret
 * redaction (sandbox), and validation errors are exercised end to end.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { handler } from "../functions/account-manage/handler.ts";
import type { LambdaResponse } from "../functions/_shared/runtime.ts";
import { resetStorageForTests, setStorageForTests } from "../functions/_shared/storage/index.ts";
import {
  normalizeCreateSandboxConfigInput,
  normalizeUpdateSandboxConfigInput,
  type SandboxConfigRecord,
} from "../functions/_shared/storage/sandbox-config.ts";
import {
  normalizeCreateWorkspaceConfigInput,
  normalizeUpdateWorkspaceConfigInput,
  type WorkspaceConfigRecord,
} from "../functions/_shared/storage/workspace-config.ts";

const ACCOUNT_ID = "acct_test";
const AUTH = { authorization: "Bearer fp_acct_test" };
const ORIGINAL_SERVICE_AUTH_SECRET = process.env.SERVICE_AUTH_SECRET;

afterEach(() => {
  if (ORIGINAL_SERVICE_AUTH_SECRET === undefined) delete process.env.SERVICE_AUTH_SECRET;
  else process.env.SERVICE_AUTH_SECRET = ORIGINAL_SERVICE_AUTH_SECRET;
  setStorageForTests(null);
  resetStorageForTests();
});

describe("account-manage sandbox endpoints", () => {
  it("creates a sandbox and redacts envVars + secret option keys on the wire", async () => {
    setStorageForTests(createFakeStorage());

    const response = await handler(createEvent("POST", "/accounts/me/sandboxes", AUTH, {
      name: "builder",
      config: {
        provider: "lambda",
        permissionMode: "bypass",
        envVars: { TOKEN: "super-secret" },
        options: { workspaceRoot: "/mnt/workspaces", apiKey: "k-123" },
      },
    }));

    expect(response.statusCode).toBe(201);
    const body = responseJson(response) as SandboxConfigRecord;
    expect(body.sandboxId).toMatch(/^sb_/);
    expect(body.name).toBe("builder");
    expect(body.config.envVars).toEqual({ TOKEN: "********" });
    expect(body.config.options).toEqual({ workspaceRoot: "/mnt/workspaces", apiKey: "********" });
  });

  it("lists, fetches, updates, and deletes a sandbox", async () => {
    setStorageForTests(createFakeStorage());

    const created = responseJson(await handler(createEvent("POST", "/accounts/me/sandboxes", AUTH, {
      name: "builder",
      config: { provider: "lambda", permissionMode: "ask" },
    }))) as SandboxConfigRecord;
    const id = created.sandboxId;

    const list = responseJson(await handler(createEvent("GET", "/accounts/me/sandboxes", AUTH))) as {
      sandboxes: SandboxConfigRecord[];
    };
    expect(list.sandboxes.map((s) => s.sandboxId)).toEqual([id]);

    const fetched = await handler(createEvent("GET", `/accounts/me/sandboxes/${id}`, AUTH));
    expect(fetched.statusCode).toBe(200);
    expect((responseJson(fetched) as SandboxConfigRecord).config.permissionMode).toBe("ask");

    const updated = await handler(createEvent("PATCH", `/accounts/me/sandboxes/${id}`, AUTH, {
      config: { permissionMode: "bypass" },
    }));
    expect(updated.statusCode).toBe(200);
    expect((responseJson(updated) as SandboxConfigRecord).config.permissionMode).toBe("bypass");

    const deleted = await handler(createEvent("DELETE", `/accounts/me/sandboxes/${id}`, AUTH));
    expect(deleted.statusCode).toBe(200);
    expect(responseJson(deleted)).toEqual({ deleted: true });

    const missing = await handler(createEvent("GET", `/accounts/me/sandboxes/${id}`, AUTH));
    expect(missing.statusCode).toBe(404);
    expect(responseJson(missing)).toEqual({ error: "Sandbox not found" });
  });

  it("returns 400 for an invalid sandbox provider", async () => {
    setStorageForTests(createFakeStorage());

    const response = await handler(createEvent("POST", "/accounts/me/sandboxes", AUTH, {
      name: "broken",
      config: { provider: "fargate" },
    }));

    expect(response.statusCode).toBe(400);
    expect(String((responseJson(response) as { error: string }).error)).toContain("config.provider must be one of");
  });

  it("rejects unauthenticated sandbox requests", async () => {
    setStorageForTests(createFakeStorage());
    const response = await handler(createEvent("GET", "/accounts/me/sandboxes"));
    expect(response.statusCode).toBe(401);
  });

  it("rejects lifecycle actions for reservation keys not owned by the account/config", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setStorageForTests(createFakeStorage());
    const created = responseJson(await handler(createEvent("POST", "/accounts/me/sandboxes", AUTH, {
      name: "persistent",
      config: { provider: "sandbox", persistent: true, options: { workdirUrl: "https://workdir.example.com", apiKey: "tenant-key" } },
    }))) as SandboxConfigRecord;

    const response = await handler(createEvent(
      "POST",
      `/accounts/me/sandboxes/${created.sandboxId}/terminate`,
      { authorization: "Bearer service-secret", "x-account-id": ACCOUNT_ID },
      { reservationKey: "fs-not-owned-by-this-account" },
    ));

    expect(response.statusCode).toBe(403);
    expect(responseJson(response)).toEqual({ error: "reservationKey does not belong to this account or sandbox config" });
  });
});

describe("account-manage workspace endpoints", () => {
  it("creates, lists, updates, and deletes a workspace (no secrets, plaintext config)", async () => {
    setStorageForTests(createFakeStorage());

    const created = await handler(createEvent("POST", "/accounts/me/workspaces", AUTH, {
      name: "notes",
      description: "shared notes",
      config: { storage: { provider: "s3" }, harness: { enabled: true } },
    }));
    expect(created.statusCode).toBe(201);
    const record = responseJson(created) as WorkspaceConfigRecord;
    expect(record.workspaceId).toMatch(/^ws_/);
    expect(record.config).toEqual({ storage: { provider: "s3" }, harness: { enabled: true } });

    const list = responseJson(await handler(createEvent("GET", "/accounts/me/workspaces", AUTH))) as {
      workspaces: WorkspaceConfigRecord[];
    };
    expect(list.workspaces).toHaveLength(1);

    const updated = await handler(createEvent("PATCH", `/accounts/me/workspaces/${record.workspaceId}`, AUTH, {
      config: { harness: { enabled: false } },
    }));
    expect((responseJson(updated) as WorkspaceConfigRecord).config.harness).toEqual({ enabled: false });

    const deleted = await handler(createEvent("DELETE", `/accounts/me/workspaces/${record.workspaceId}`, AUTH));
    expect(responseJson(deleted)).toEqual({ deleted: true });
  });

  it("returns 400 for an unsupported storage provider", async () => {
    setStorageForTests(createFakeStorage());

    const response = await handler(createEvent("POST", "/accounts/me/workspaces", AUTH, {
      name: "broken",
      config: { storage: { provider: "vercel" } },
    }));

    expect(response.statusCode).toBe(400);
    expect(String((responseJson(response) as { error: string }).error)).toContain('config.storage.provider "vercel" is not supported yet');
  });

  it("returns 404 when updating a missing workspace", async () => {
    setStorageForTests(createFakeStorage());
    const response = await handler(createEvent("PATCH", "/accounts/me/workspaces/ws_missing", AUTH, { name: "x" }));
    expect(response.statusCode).toBe(404);
    expect(responseJson(response)).toEqual({ error: "Workspace not found" });
  });

  it("allows the Convex service token to reach workspace file routes", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setStorageForTests(createFakeStorage());
    const created = responseJson(await handler(createEvent("POST", "/accounts/me/workspaces", AUTH, {
      name: "notes",
      config: { storage: { provider: "s3" } },
    }))) as WorkspaceConfigRecord;

    const response = await handler(createEvent(
      "PUT",
      `/accounts/me/workspaces/${created.workspaceId}/files`,
      { authorization: "Bearer service-secret", "x-account-id": ACCOUNT_ID },
    ));

    expect(response.statusCode).toBe(405);
    expect(responseJson(response)).toMatchObject({ error: "Method not allowed" });
  });
});

function responseJson(response: LambdaResponse): unknown {
  return JSON.parse(String(response.body ?? "{}"));
}

function fakeAccount() {
  return {
    accountId: ACCOUNT_ID,
    username: "company-a",
    secretHash: "hash",
    status: "active" as const,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

/** In-memory sandbox/workspace stores driven by the real normalizers. */
function createFakeStorage() {
  const sandboxes = new Map<string, SandboxConfigRecord>();
  const workspaces = new Map<string, WorkspaceConfigRecord>();
  let counter = 0;
  const stamp = "2026-05-01T00:00:00.000Z";

  return {
    kind: "fake",
    accounts: {
      async getById() { return fakeAccount(); },
      async getBySecretHash() { return fakeAccount(); },
      async list() { return [fakeAccount()]; },
      async create() { return { account: fakeAccount(), secret: "fp_acct_fake" }; },
      async update() { return fakeAccount(); },
      async rotateSecret() { return { account: fakeAccount(), secret: "fp_acct_fake" }; },
      async remove() { return true; },
    },
    agents: {} as never,
    agentDeployments: {
      async getByApiKeyHash() { return null; },
    },
    crons: {} as never,
    sandboxConfigs: {
      async getById(_accountId: string, id: string) { return sandboxes.get(id) ?? null; },
      async list() { return [...sandboxes.values()]; },
      async create(accountId: string, input: unknown) {
        const n = normalizeCreateSandboxConfigInput(input as never);
        const sandboxId = `sb_${++counter}`;
        const record: SandboxConfigRecord = {
          accountId, sandboxId, name: n.name,
          ...(n.description ? { description: n.description } : {}),
          config: n.config, createdAt: stamp, updatedAt: stamp,
        };
        sandboxes.set(sandboxId, record);
        return record;
      },
      async update(_accountId: string, id: string, patch: unknown) {
        const existing = sandboxes.get(id);
        if (!existing) return null;
        const n = normalizeUpdateSandboxConfigInput(existing.config, patch as never);
        const record: SandboxConfigRecord = { ...existing, config: n.config, updatedAt: stamp };
        if (n.name !== undefined) record.name = n.name;
        if (n.description === null) delete record.description;
        else if (n.description !== undefined) record.description = n.description;
        sandboxes.set(id, record);
        return record;
      },
      async remove(_accountId: string, id: string) { return sandboxes.delete(id); },
      async removeAllForAccount() { const n = sandboxes.size; sandboxes.clear(); return n; },
    },
    workspaceConfigs: {
      async getById(_accountId: string, id: string) { return workspaces.get(id) ?? null; },
      async list() { return [...workspaces.values()]; },
      async create(accountId: string, input: unknown) {
        const n = normalizeCreateWorkspaceConfigInput(input as never);
        const workspaceId = `ws_${++counter}`;
        const record: WorkspaceConfigRecord = {
          accountId, workspaceId, name: n.name,
          ...(n.description ? { description: n.description } : {}),
          config: n.config, createdAt: stamp, updatedAt: stamp,
        };
        workspaces.set(workspaceId, record);
        return record;
      },
      async update(_accountId: string, id: string, patch: unknown) {
        const existing = workspaces.get(id);
        if (!existing) return null;
        const n = normalizeUpdateWorkspaceConfigInput(existing.config, patch as never);
        const record: WorkspaceConfigRecord = { ...existing, config: n.config, updatedAt: stamp };
        if (n.name !== undefined) record.name = n.name;
        if (n.description === null) delete record.description;
        else if (n.description !== undefined) record.description = n.description;
        workspaces.set(id, record);
        return record;
      },
      async remove(_accountId: string, id: string) { return workspaces.delete(id); },
      async removeAllForAccount() { const n = workspaces.size; workspaces.clear(); return n; },
    },
  } as never;
}

function createEvent(
  method: string,
  rawPath: string,
  headers: Record<string, string> = {},
  body?: unknown,
): LambdaFunctionURLEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "example.lambda-url.aws",
      domainPrefix: "example",
      http: {
        method,
        path: rawPath,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "bun-test",
      },
      requestId: "request-id",
      routeKey: "$default",
      stage: "$default",
      time: "01/May/2026:00:00:00 +0000",
      timeEpoch: 1777593600000,
    },
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
