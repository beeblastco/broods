import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { purgeWorkspaceFilesystem } from "../model/workspaceFs";
import { workspaceNamespace } from "../model/workspaceRules";

const { bucketKeys, mockSend } = vi.hoisted(() => {
  const bucketKeys = new Set<string>();
  const mockSend = vi.fn(
    async (
      command: ListObjectsV2Command | DeleteObjectCommand,
    ): Promise<{ Contents?: { Key: string }[] }> => {
      // Only the managed bucket holds objects, so a purge aimed at any other
      // bucket deletes nothing and fails the assertions.
      if (command.input.Bucket !== "managed-workspace-bucket") return {};
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? "";

        return {
          Contents: [...bucketKeys]
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ Key: key })),
        };
      }
      bucketKeys.delete(command.input.Key ?? "");

      return {};
    },
  );

  return { bucketKeys: bucketKeys, mockSend: mockSend };
});

vi.mock("../model/aws", () => ({
  assumeScopedS3Credentials: vi.fn(async () => ({
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "secret",
    sessionToken: "token",
  })),
  s3Client: vi.fn(async () => ({ send: mockSend })),
}));

beforeEach(() => {
  vi.stubEnv("FILESYSTEM_BUCKET_NAME", "managed-workspace-bucket");
  bucketKeys.clear();
  mockSend.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("purge deletes only objects under the workspace namespace", async () => {
  const namespace = await workspaceNamespace("account_a", "workspace_a");
  const neighbour = await workspaceNamespace("account_a", "workspace_b");
  bucketKeys.add(`${namespace}/notes.md`);
  bucketKeys.add(`${namespace}/src/index.ts`);
  bucketKeys.add(`${neighbour}/notes.md`);
  bucketKeys.add(`${namespace}-archive/notes.md`);

  const deleted = await purgeWorkspaceFilesystem({
    accountId: "account_a",
    workspaceId: "workspace_a",
  });

  expect(deleted).toBe(2);
  expect(bucketKeys).toEqual(
    new Set([`${neighbour}/notes.md`, `${namespace}-archive/notes.md`]),
  );
});

test("purge refuses a bring-your-own bucket with no prefix", async () => {
  await expect(
    purgeWorkspaceFilesystem({
      accountId: "account_a",
      workspaceId: "workspace_a",
      storage: {
        provider: "s3",
        bucket: "customer-owned-bucket",
        auth: {
          type: "assumeRole",
          roleArn: "arn:aws:iam::123456789012:role/broods-workspace",
        },
      },
    }),
  ).rejects.toThrow(
    "Refusing to purge a workspace bucket without a key prefix",
  );
  expect(mockSend).not.toHaveBeenCalled();
});
