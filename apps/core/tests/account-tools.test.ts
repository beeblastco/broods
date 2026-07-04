/**
 * Account custom tool API tests.
 * Exercise account-scoped CRUD without touching real S3 or DynamoDB.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  resetStorageForTests,
  setStorageForTests,
  type AccountRecord,
  type AccountToolRecord,
  type CreateAccountToolInput,
  type StorageProvider,
  type UpdateAccountToolInput,
} from "../src/shared/storage/index.ts";
import { coreRequest, responseJson } from "./helpers/http.ts";

const writeS3ObjectMock = mock(async () => 1);

mock.module("../src/shared/s3.ts", () => ({
  writeS3Object: writeS3ObjectMock,
}));

beforeEach(() => {
  process.env.TOOL_BUNDLES_BUCKET_NAME = "tool-bundles";
  writeS3ObjectMock.mockClear();
  resetStorageForTests();
});

afterEach(() => {
  resetStorageForTests();
});

describe("account tool API", () => {
  it("creates, lists, gets, updates, and deletes account tools", async () => {
    const store = inMemoryStorage();
    setStorageForTests(store);
    const { handler } = await import("../src/accounts/handler.ts");

    const createResponse = await handler(event("POST", "/accounts/me/tools", {
      name: "test_async",
      description: "Uploaded test tool.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      bundle: "export default { name: 'test_async', async execute() { return { ok: true }; } };",
      defaultConfig: { delayMs: 1 },
    }));
    expect(createResponse.status).toBe(201);
    const created = await responseJson(createResponse);
    expect(created.toolId).toBe("tool_abc123");
    expect(created.name).toBe("test_async");
    expect(created).not.toHaveProperty("bundle");
    expect(writeS3ObjectMock).toHaveBeenCalledTimes(1);

    const listResponse = await handler(event("GET", "/accounts/me/tools"));
    expect((await responseJson(listResponse)).tools).toHaveLength(1);

    const getResponse = await handler(event("GET", "/accounts/me/tools/tool_abc123"));
    expect((await responseJson(getResponse)).description).toBe("Uploaded test tool.");

    const patchResponse = await handler(event("PATCH", "/accounts/me/tools/tool_abc123", {
      description: "Updated.",
    }));
    expect((await responseJson(patchResponse)).description).toBe("Updated.");

    const deleteResponse = await handler(event("DELETE", "/accounts/me/tools/tool_abc123"));
    expect(deleteResponse.status).toBe(200);

    const missingResponse = await handler(event("GET", "/accounts/me/tools/tool_abc123"));
    expect(missingResponse.status).toBe(404);
  });

  it("rejects invalid uploads", async () => {
    setStorageForTests(inMemoryStorage());
    const { handler } = await import("../src/accounts/handler.ts");

    const response = await handler(event("POST", "/accounts/me/tools", {
      name: "bad name",
      description: "Invalid",
      inputSchema: { type: "object" },
      bundle: "export default {};",
    }));

    expect(response.status).toBe(400);
    expect((await responseJson(response)).error).toContain("tool.name");
  });
});

function inMemoryStorage(): StorageProvider {
  const records = new Map<string, AccountToolRecord>();
  const account: AccountRecord = {
    accountId: "acct_test",
    username: "acct",
    secretHash: "hash",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  return {
    kind: "dynamodb",
    accounts: {
      async getBySecretHash() {
        return account;
      },
    } as never,
	    agents: {} as never,
	    agentDeployments: {
	      async getByApiKeyHash() {
	        return null;
	      },
	    },
	    crons: {} as never,
    sandboxConfigs: {} as never,
    workspaceConfigs: {} as never,
    agentPolicies: {} as never,
    accountTools: {
      async getById(accountId, toolId) {
        return records.get(`${accountId}:${toolId}`) ?? null;
      },
      async list(accountId) {
        return [...records.values()].filter((record) => record.accountId === accountId && record.status === "active");
      },
      async create(accountId, input: CreateAccountToolInput) {
        const now = "2026-06-06T00:00:00.000Z";
        const record: AccountToolRecord = {
          accountId,
          toolId: "tool_abc123",
          name: input.name,
          description: input.description,
          inputSchema: input.inputSchema,
          bundleStorageKey: input.bundleStorageKey,
          sha256: input.sha256,
          ...(input.defaultConfig !== undefined ? { defaultConfig: input.defaultConfig } : {}),
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        records.set(`${accountId}:${record.toolId}`, record);
        return record;
      },
      async update(accountId, toolId, patch: UpdateAccountToolInput) {
        const record = records.get(`${accountId}:${toolId}`);
        if (!record || record.status !== "active") return null;
        const updated: AccountToolRecord = {
          ...record,
          ...patch,
          defaultConfig: patch.defaultConfig === null ? undefined : patch.defaultConfig ?? record.defaultConfig,
          updatedAt: "2026-06-06T00:01:00.000Z",
        };
        records.set(`${accountId}:${toolId}`, updated);
        return updated;
      },
      async remove(accountId, toolId) {
        const record = records.get(`${accountId}:${toolId}`);
        if (!record) return false;
        records.set(`${accountId}:${toolId}`, {
          ...record,
          status: "deleted",
          deletedAt: "2026-06-06T00:02:00.000Z",
        });
        return true;
      },
      async removeAllForAccount(accountId) {
        const tools = [...records.values()].filter((record) => record.accountId === accountId);
        for (const tool of tools) records.delete(`${accountId}:${tool.toolId}`);
        return tools.length;
      },
    },
    usage: { async recordTask() {} },
  } as StorageProvider;
}

function event(method: string, rawPath: string, body?: unknown) {
  return coreRequest(method, rawPath, { authorization: "Bearer test-secret" }, body);
}
