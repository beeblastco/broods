/**
 * Mounted workspace file API tests.
 * Cover namespace mapping, virtual folders, writes, deletes, and path safety.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

const listMock = mock(async (_bucket: string, _prefix: string) => [] as Array<{
  key: string;
  size?: number;
  lastModified?: string;
}>);
const writeMock = mock(async (
  _bucket: string,
  _key: string,
  _body: string | Uint8Array,
  _options?: { contentType?: string },
) => 0);
const ensureDirectoriesMock = mock(async (_bucket: string, _key: string) => {});
const deletePrefixMock = mock(async (_bucket: string, _prefix: string) => 0);
const deleteObjectMock = mock(async (_bucket: string, _key: string) => {});
const existsMock = mock(async (_bucket: string, _key: string) => false);

mock.module("../functions/_shared/s3.ts", () => ({
  listS3Prefix: listMock,
  readS3Text: mock(async () => ""),
  readS3Bytes: mock(async () => new Uint8Array()),
  writeS3Object: writeMock,
  ensureS3DirectoryMarkers: ensureDirectoriesMock,
  deleteS3Prefix: deletePrefixMock,
  deleteS3Object: deleteObjectMock,
  s3ObjectExists: existsMock,
  copyS3Object: mock(async () => {}),
  getS3ObjectUrl: mock(async () => "https://example.test/file"),
  isMissingS3Error: mock(() => false),
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
  listMock.mockClear();
  writeMock.mockClear();
  ensureDirectoriesMock.mockClear();
  deletePrefixMock.mockClear();
  deleteObjectMock.mockClear();
  existsMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("workspace file storage", () => {
  it("lists files from the runtime sandbox namespace and creates virtual folders", async () => {
    listMock.mockImplementationOnce(async (_bucket, prefix) => [{
      key: `${prefix}src/components/Button.tsx`,
      size: 42,
      lastModified: "2026-06-18T00:00:00.000Z",
    }]);
    const { listWorkspaceFiles } = await import("../functions/account-manage/workspace-files.ts");

    const files = await listWorkspaceFiles("acct_test", "ws_test");

    expect(listMock.mock.calls[0]?.[0]).toBe("workspace-bucket");
    expect(listMock.mock.calls[0]?.[1]).toMatch(/^fs-[a-f0-9]{40}\/$/);
    expect(files).toEqual([
      { path: "src", name: "src", isFolder: true },
      { path: "src/components", name: "components", isFolder: true },
      {
        path: "src/components/Button.tsx",
        name: "Button.tsx",
        isFolder: false,
        sizeBytes: 42,
        updatedAt: "2026-06-18T00:00:00.000Z",
      },
    ]);
  });

  it("writes dashboard uploads into the mounted namespace with directory metadata", async () => {
    const { uploadWorkspaceFile } = await import("../functions/account-manage/workspace-files.ts");

    const file = await uploadWorkspaceFile("acct_test", "ws_test", {
      path: "notes/new.txt",
      contentBase64: Buffer.from("hello").toString("base64"),
      contentType: "text/plain",
    });

    const key = String(writeMock.mock.calls[0]?.[1]);
    expect(key).toMatch(/^fs-[a-f0-9]{40}\/notes\/new\.txt$/);
    expect(ensureDirectoriesMock).toHaveBeenCalledWith("workspace-bucket", key);
    expect(writeMock.mock.calls[0]?.[2]).toEqual(Buffer.from("hello"));
    expect(file).toEqual({ path: "notes/new.txt", name: "new.txt", isFolder: false, sizeBytes: 5 });
  });

  it("deletes both a folder prefix and its directory marker", async () => {
    deletePrefixMock.mockResolvedValueOnce(3);
    existsMock.mockResolvedValueOnce(true);
    const { deleteWorkspacePath } = await import("../functions/account-manage/workspace-files.ts");

    const deleted = await deleteWorkspacePath("acct_test", "ws_test", "notes");

    expect(deleted).toBe(4);
    expect(String(deletePrefixMock.mock.calls[0]?.[1])).toMatch(/\/notes\/$/);
    expect(String(deleteObjectMock.mock.calls[0]?.[1])).toMatch(/\/notes$/);
  });

  it("rejects traversal before touching S3", async () => {
    const { uploadWorkspaceFile } = await import("../functions/account-manage/workspace-files.ts");

    await expect(uploadWorkspaceFile("acct_test", "ws_test", {
      path: "../secret.txt",
      contentBase64: "",
    })).rejects.toThrow("Invalid workspace path");
    expect(writeMock).not.toHaveBeenCalled();
  });
});
