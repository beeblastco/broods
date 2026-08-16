/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { purgeProject } from "./model/cascade";
import { workspaceNamespace } from "./model/workspaceRules";
import schema from "./schema";

const { mockS3Client, mockSend } = vi.hoisted(() => {
  const mockSend = vi.fn(async () => ({ Contents: [] }));
  const mockS3Client = vi.fn(async () => ({ send: mockSend }));

  return { mockS3Client: mockS3Client, mockSend: mockSend };
});

vi.mock("./model/aws", () => ({
  assumeScopedS3Credentials: vi.fn(),
  s3Client: mockS3Client,
}));

const modules = import.meta.glob("./**/*.ts");

test("project deletion purges its managed workspace namespace", async () => {
  const originalFilesystemBucketName = process.env.FILESYSTEM_BUCKET_NAME;
  vi.useFakeTimers();
  process.env.FILESYSTEM_BUCKET_NAME = "managed-workspace-bucket";
  mockS3Client.mockClear();
  mockSend.mockClear();

  try {
    const t = convexTest(schema, modules);
    const { accountId, projectId, workspaceId } = await t.run(async (ctx) => {
      const now = Date.now();
      const orgId = await ctx.db.insert("orgs", {
        name: "beeblast",
        slug: "beeblast",
        ownerAuthId: "auth_owner",
        plan: "free",
        createdAt: now,
      });
      const accountId = await ctx.db.insert("accounts", {
        orgId: orgId,
        username: "beeblast",
        secretHash: "hash",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      const projectId = await ctx.db.insert("projects", {
        authId: "auth_owner",
        orgId: orgId,
        name: "demo-app",
        slug: "demo-app",
        updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        authId: "auth_owner",
        projectId: projectId,
        name: "Development",
        kind: "development",
        isDefault: true,
        updatedAt: now,
      });
      const workspaceId = await ctx.db.insert("workspaceConfigs", {
        accountId: accountId,
        projectId: projectId,
        stageId: stageId,
        name: "repo",
        config: { storage: { provider: "s3" } },
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("workspaceConfigs", {
        accountId: accountId,
        projectId: projectId,
        stageId: stageId,
        name: "customer-files",
        config: {
          storage: {
            provider: "s3",
            bucket: "customer-owned-bucket",
            prefix: "broods",
          },
        },
        createdAt: now,
        updatedAt: now,
      });

      return {
        accountId: accountId,
        projectId: projectId,
        workspaceId: workspaceId,
      };
    });

    await t.run(async (ctx) => {
      await purgeProject(ctx, projectId);
    });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const namespace = await workspaceNamespace(accountId, workspaceId);
    expect(mockS3Client).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "managed-workspace-bucket",
          Prefix: `${namespace}/`,
        }),
      }),
    );
  } finally {
    if (originalFilesystemBucketName === undefined) {
      delete process.env.FILESYSTEM_BUCKET_NAME;
    } else {
      process.env.FILESYSTEM_BUCKET_NAME = originalFilesystemBucketName;
    }
    vi.useRealTimers();
  }
});
