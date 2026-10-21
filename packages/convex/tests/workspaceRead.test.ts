import type { GetObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readWorkspaceFile } from "../model/workspaceFs";
import { workspaceNamespace } from "../model/workspaceRules";

const { bucket, mockSend } = vi.hoisted(() => {
  const bucket = new Map<string, Uint8Array>();
  const mockSend = vi.fn(
    async (
      command: GetObjectCommand,
    ): Promise<{
      Body: { transformToByteArray: () => Promise<Uint8Array> };
    }> => {
      const bytes = bucket.get(command.input.Key ?? "");
      if (!bytes)
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });

      return { Body: { transformToByteArray: async () => bytes } };
    },
  );

  return { bucket: bucket, mockSend: mockSend };
});

vi.mock("../model/aws", () => ({
  assumeScopedS3Credentials: vi.fn(),
  s3Client: vi.fn(async () => ({ send: mockSend })),
}));

const REF = { accountId: "account_a", workspaceId: "workspace_a" };

beforeEach(() => {
  vi.stubEnv("FILESYSTEM_BUCKET_NAME", "managed-workspace-bucket");
  bucket.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("reads a file under the workspace's own namespace as text", async () => {
  const namespace = await workspaceNamespace("account_a", "workspace_a");
  bucket.set(`${namespace}/docs/guide.md`, new TextEncoder().encode("# Guide"));

  expect(await readWorkspaceFile(REF, "docs/guide.md")).toBe("# Guide");
});

test("a missing file is a client error, not a crash", async () => {
  await expect(readWorkspaceFile(REF, "gone.txt")).rejects.toThrow(
    "Workspace file not found",
  );
});

test("a file over the upload limit is refused", async () => {
  const namespace = await workspaceNamespace("account_a", "workspace_a");
  bucket.set(`${namespace}/big.log`, new Uint8Array(512 * 1024 + 1));

  await expect(readWorkspaceFile(REF, "big.log")).rejects.toThrow(
    "cannot be previewed",
  );
});
