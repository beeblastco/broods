/**
 * Workspace deletion route tests.
 * Keep destructive filesystem cleanup assertions separate so S3 is mocked before
 * the account-management handler imports cleanup.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { workspaceNamespacePrefix } from "../src/shared/sandbox.ts";
import { resetStorageForTests, setStorageForTests } from "../src/shared/storage/index.ts";
import type { WorkspaceConfigRecord } from "../src/shared/storage/workspace-config.ts";
import { workspaceNamespace } from "../src/shared/workspaces.ts";
import { coreRequest, responseJson } from "./helpers/http.ts";

const deletePrefixMock = mock(async (_bucket: string, _prefix: string, _access?: unknown) => 3);

mock.module("../src/shared/s3.ts", () => ({
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

    const { handler } = await import("../src/accounts/handler.ts");
    const response = await handler(createEvent("DELETE", `/v1/workspaces/${workspace.workspaceId}`, AUTH));

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ deleted: true });
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

function createEvent(
  method: string,
  rawPath: string,
  headers: Record<string, string> = {},
): ReturnType<typeof coreRequest> {
  return coreRequest(method, rawPath, headers);
}
