/**
 * Workspace deletion route tests.
 * Keep destructive filesystem cleanup assertions separate so S3 is mocked before
 * the account-management handler imports cleanup.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import type { LambdaResponse } from "../functions/_shared/runtime.ts";
import { workspaceNamespacePrefix } from "../functions/_shared/sandbox.ts";
import { resetStorageForTests, setStorageForTests } from "../functions/_shared/storage/index.ts";
import type { WorkspaceConfigRecord } from "../functions/_shared/storage/workspace-config.ts";
import { workspaceNamespace } from "../functions/_shared/workspaces.ts";

const deletePrefixMock = mock(async (_bucket: string, _prefix: string, _access?: unknown) => 3);

mock.module("../functions/_shared/s3.ts", () => ({
  deleteS3Prefix: deletePrefixMock,
  readS3Text: mock(async () => ""),
  readS3Bytes: mock(async () => new Uint8Array()),
  writeS3Object: mock(async () => 200),
  s3ObjectExists: mock(async () => false),
  listS3Prefix: mock(async () => []),
  deleteS3Object: mock(async () => {}),
  copyS3Object: mock(async () => {}),
  ensureS3DirectoryMarkers: mock(async () => {}),
  isMissingS3Error: mock(() => false),
}));

const ACCOUNT_ID = "acct_test";
const AUTH = { authorization: "Bearer fp_acct_test" };
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
  deletePrefixMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  setStorageForTests(null);
  resetStorageForTests();
});

describe("workspace delete cleanup", () => {
  it("deletes the workspace filesystem prefix before removing the config", async () => {
    const workspace: WorkspaceConfigRecord = {
      accountId: ACCOUNT_ID,
      workspaceId: "ws_1",
      name: "notes",
      config: { storage: { provider: "s3" }, isolation: true },
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    };
    let removed = false;
    setStorageForTests({
      accounts: {
        async getById() { return fakeAccount(); },
        async getBySecretHash() { return fakeAccount(); },
      },
      agents: {} as never,
      agentDeployments: {
        async getByApiKeyHash() { return null; },
      },
      crons: {} as never,
      sandboxConfigs: {
        async list() { return []; },
      },
      workspaceConfigs: {
        async getById(_accountId: string, id: string) {
          return !removed && id === workspace.workspaceId ? workspace : null;
        },
        async remove(_accountId: string, id: string) {
          if (id !== workspace.workspaceId || removed) return false;
          removed = true;
          return true;
        },
      },
    } as never);

    const { handler } = await import("../functions/account-manage/handler.ts");
    const response = await handler(createEvent("DELETE", `/accounts/me/workspaces/${workspace.workspaceId}`, AUTH));

    expect(response.statusCode).toBe(200);
    expect(responseJson(response)).toEqual({ deleted: true });
    expect(removed).toBe(true);
    expect(deletePrefixMock).toHaveBeenCalledWith(
      "workspace-bucket",
      `${workspaceNamespacePrefix(workspaceNamespace(ACCOUNT_ID, workspace.workspaceId))}/`,
      undefined,
    );
  });
});

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

function responseJson(response: LambdaResponse): unknown {
  return JSON.parse(String(response.body ?? "{}"));
}

function createEvent(
  method: string,
  rawPath: string,
  headers: Record<string, string> = {},
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
  };
}
