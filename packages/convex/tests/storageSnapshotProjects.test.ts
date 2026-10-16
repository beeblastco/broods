/// <reference types="vite/client" />
/**
 * The daily storage snapshot's split by project: each project is billed what
 * its own workspaces hold, and the account the whole size.
 */

import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { workspaceNamespace } from "../model/workspaceRules";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const NOW = Date.UTC(2026, 9, 16, 3);
const GB = 1e9;

// Bytes per S3 prefix, filled per test.
const stored = vi.hoisted(() => new Map<string, number>());

// Only the S3 listing is replaced; the snapshot's reads and writes stay real.
vi.mock("../model/s3", async (importOriginal) => {
  const original = await importOriginal<typeof import("../model/s3")>();

  return {
    ...original,
    listS3Prefix: async (bucket: string, prefix: string) => {
      const size = stored.get(`${bucket}/${prefix}`);

      return size === undefined ? [] : [{ key: `${prefix}x`, size: size }];
    },
  };
});

afterEach(() => {
  stored.clear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test("bills each project its own workspaces and the account everything", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubEnv("FILESYSTEM_BUCKET_NAME", "fs");
  vi.stubEnv("SKILLS_BUCKET_NAME", "skills");
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "pro",
      createdAt: NOW,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash",
      status: "active" as const,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const project = async (name: string): Promise<Id<"projects">> =>
      await ctx.db.insert("projects", {
        authId: "auth_owner",
        orgId: orgId,
        name: name,
        slug: name,
        updatedAt: NOW,
      });
    const support = await project("support");
    const sales = await project("sales");
    const workspace = async (
      name: string,
      projectId?: Id<"projects">,
    ): Promise<Id<"workspaceConfigs">> =>
      await ctx.db.insert("workspaceConfigs", {
        accountId: accountId,
        ...(projectId ? { projectId: projectId } : {}),
        name: name,
        config: {},
        createdAt: NOW,
        updatedAt: NOW,
      });

    return {
      accountId: accountId,
      support: support,
      sales: sales,
      workspaces: {
        supportA: await workspace("a", support),
        supportB: await workspace("b", support),
        sales: await workspace("c", sales),
        shared: await workspace("shared"),
      },
    };
  });
  const holds = async (
    workspaceId: Id<"workspaceConfigs">,
    bytes: number,
  ): Promise<void> => {
    const namespace = await workspaceNamespace(seeded.accountId, workspaceId);
    stored.set(`fs/${namespace}/`, bytes);
  };
  await holds(seeded.workspaces.supportA, 2 * GB);
  await holds(seeded.workspaces.supportB, 1 * GB);
  await holds(seeded.workspaces.sales, 0);
  await holds(seeded.workspaces.shared, 4 * GB);
  stored.set(`skills/${seeded.accountId}/`, 0.5 * GB);

  await t.action(internal.aws.storageMeter.snapshotAccount, {
    accountId: seeded.accountId,
    snapshotAt: NOW,
  });

  const { meter, days } = await t.run(async (ctx) => ({
    meter: await ctx.db.query("usageMeters").unique(),
    days: await ctx.db.query("usageProjectDays").collect(),
  }));
  expect(meter?.storageGb).toBeCloseTo(7.5, 9);
  const byProject = new Map(days.map((day) => [day.projectId, day]));
  expect(byProject.get(seeded.support)?.storageGb).toBeCloseTo(3, 9);
  expect(byProject.get(seeded.sales)?.storageGb).toBe(0);
  expect(days).toHaveLength(2);
});
