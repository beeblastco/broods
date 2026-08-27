/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { purgeProject } from "../model/cascade";
import { workspaceNamespace } from "../model/workspaceRules";
import schema from "../schema";

const { mockS3Client, mockSend, mockSchedulerClient, mockSchedulerSend } =
  vi.hoisted(() => {
    const mockSend = vi.fn(async () => ({ Contents: [] }));
    const mockS3Client = vi.fn(async () => ({ send: mockSend }));
    const mockSchedulerSend = vi.fn(async () => ({}));
    const mockSchedulerClient = vi.fn(async () => ({
      send: mockSchedulerSend,
    }));

    return {
      mockS3Client: mockS3Client,
      mockSend: mockSend,
      mockSchedulerClient: mockSchedulerClient,
      mockSchedulerSend: mockSchedulerSend,
    };
  });

vi.mock("../model/aws", () => ({
  assumeScopedS3Credentials: vi.fn(),
  s3Client: mockS3Client,
  schedulerClient: mockSchedulerClient,
}));

const modules = import.meta.glob("../**/*.ts");

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

test("project deletion drains cron run history in scheduled batches", async () => {
  vi.useFakeTimers();
  mockSchedulerClient.mockClear();
  mockSchedulerSend.mockClear();

  try {
    const t = convexTest(schema, modules);
    const { accountId, projectId, cronId } = await t.run(async (ctx) => {
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
      const agentId = await ctx.db.insert("agents", {
        accountId: accountId,
        name: "scheduler-agent",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("agentConfigs", {
        authId: "auth_owner",
        name: "scheduler-agent",
        agentId: agentId,
        projectId: projectId,
        stageId: stageId,
        updatedAt: now,
      });
      const cronId = await ctx.db.insert("crons", {
        accountId: accountId,
        name: "nightly",
        agentId: agentId,
        events: [],
        scheduleExpression: "cron(0 0 * * ? *)",
        status: "active",
        schedulerName: "broods-cron-nightly",
        schedulerGroupName: "broods-crons",
        createdAt: now,
        updatedAt: now,
      });
      // More runs than one deletion batch holds, so the drain must reschedule
      // itself at least once to finish.
      for (let index = 0; index < 120; index += 1) {
        await ctx.db.insert("cronRuns", {
          accountId: accountId,
          cronId: cronId,
          eventId: `event-${index}`,
          conversationKey: `cron:${index}`,
          status: "completed",
          startedAt: now - index,
        });
      }

      return { accountId: accountId, projectId: projectId, cronId: cronId };
    });

    await t.run(async (ctx) => {
      await purgeProject(ctx, projectId);
    });

    // The cron row dies inside the purge transaction; its run history drains
    // through scheduled batches afterwards.
    await t.run(async (ctx) => {
      expect(await ctx.db.get(cronId)).toBeNull();
    });

    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    await t.run(async (ctx) => {
      const runs = await ctx.db
        .query("cronRuns")
        .withIndex("by_accountId_and_cronId_and_startedAt", (q) =>
          q.eq("accountId", accountId).eq("cronId", cronId),
        )
        .collect();
      expect(runs).toHaveLength(0);
    });
    // The EventBridge schedule removal ran once for the deleted cron.
    expect(mockSchedulerSend).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
