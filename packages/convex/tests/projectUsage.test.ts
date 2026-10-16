/// <reference types="vite/client" />
/**
 * The usage meter split by project: what lands on a project's day from the
 * sandbox mirror, core's writes and the storage snapshot, and the Usage
 * tab's read of each project's month.
 */

import cronsComponent from "@convex-dev/crons/test";
import workosTest from "@convex-dev/workos-authkit/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { budgetUsage, projectUsage } from "../model/usageMeter";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const AUTH_ID = "user_project_usage_owner";
const NOW = Date.UTC(2026, 9, 16, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

const meterTest = () => convexTest(schema, modules);

type T = ReturnType<typeof meterTest>;

interface Org {
  orgId: Id<"orgs">;
  accountId: Id<"accounts">;
  projects: Id<"projects">[];
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("usage lands on its project's day", () => {
  test("a sandbox in a project bills the project and the account; an account-wide one only the account", async () => {
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const org = await seedOrg(t, "beeblast", ["Support bot"]);
    const [projectId] = org.projects;

    for (const [key, scope] of [
      ["fs-project", { projectId: projectId }],
      ["fs-account", {}],
    ] as const) {
      await t.mutation(internal.sandbox.instances.upsert, {
        accountId: org.accountId,
        ...scope,
        provider: "lambda",
        reservationKey: key,
        externalId: `vm-${key}`,
        name: "default",
        specs: { vcpu: 1, memoryMb: 2048, storageGb: 8 },
      });
    }
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    for (const key of ["fs-project", "fs-account"]) {
      await t.mutation(internal.sandbox.instances.remove, {
        accountId: org.accountId,
        reservationKey: key,
      });
    }

    const { meter, projectDays } = await t.run(async (ctx) => ({
      meter: await ctx.db.query("usageMeters").unique(),
      projectDays: await ctx.db.query("usageProjectDays").collect(),
    }));
    expect(meter).toMatchObject({
      sandboxVcpuSeconds: 1200,
      sandboxSnapshotGb: 4,
    });
    expect(projectDays).toHaveLength(1);
    expect(projectDays[0]).toMatchObject({
      projectId: projectId,
      day: "2026-10-16",
      sandboxVcpuSeconds: 600,
      sandboxGbSeconds: 1200,
      sandboxSnapshotGb: 2,
    });
  });

  test("core's writes find their project by id, agent or workspace", async () => {
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const org = await seedOrg(t, "beeblast", ["Support bot", "Sales"]);
    const [support, sales] = org.projects;
    const { agentId, workspaceId } = await seedAgentAndWorkspace(t, org, sales);

    await record(t, org, { hostedMcpRequests: 1 }, { projectId: support });
    await record(t, org, { ingressGb: 2 }, { agentId: agentId });
    await record(t, org, { egressGb: 3 }, { workspaceId: workspaceId });

    const days = await projectDays(t);
    expect(days.get(support)).toMatchObject({ hostedMcpRequests: 1 });
    expect(days.get(sales)).toMatchObject({ ingressGb: 2, egressGb: 3 });
    const meter = await t.run(async (ctx) =>
      ctx.db.query("usageMeters").unique(),
    );
    expect(meter).toMatchObject({
      hostedMcpRequests: 1,
      ingressGb: 2,
      egressGb: 3,
    });
  });

  test("a source outside the account, or unknown, counts for the account alone", async () => {
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const org = await seedOrg(t, "beeblast", ["Support bot"]);
    const other = await seedOrg(t, "rival", ["Rival project"]);
    const foreign = await seedAgentAndWorkspace(t, other, other.projects[0]);

    for (const source of [
      { projectId: other.projects[0] },
      { agentId: foreign.agentId },
      { workspaceId: foreign.workspaceId },
      { projectId: "not-an-id" },
      { agentId: "agent_missing" },
      { workspaceId: "not-an-id" },
    ]) {
      await record(t, org, { egressGb: 1 }, source);
    }

    expect((await projectDays(t)).size).toBe(0);
    const meter = await t.run(async (ctx) =>
      ctx.db.query("usageMeters").unique(),
    );
    expect(meter?.egressGb).toBe(6);
  });

  test("a retried write with a source counts once on the project too", async () => {
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const org = await seedOrg(t, "beeblast", ["Support bot"]);
    const write = {
      accountId: org.accountId,
      usage: { egressGb: 1 },
      writeId: "write-1",
      source: { projectId: org.projects[0] },
    };

    await t.mutation(internal.account.budget.record, write);
    await t.mutation(internal.account.budget.record, write);

    expect((await projectDays(t)).get(org.projects[0])?.egressGb).toBe(1);
  });

  test("the storage snapshot sets each project's size without adding to the account's", async () => {
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const org = await seedOrg(t, "beeblast", ["Support bot", "Sales"]);
    const [support, sales] = org.projects;

    await t.mutation(internal.account.budget.record, {
      accountId: org.accountId,
      usage: { storageGbMonths: 10 / 30 },
      projectStorage: [
        { projectId: support, storageGbMonths: 4 / 30 },
        { projectId: sales, storageGbMonths: 0 },
      ],
    });

    const meter = await t.run(async (ctx) =>
      ctx.db.query("usageMeters").unique(),
    );
    expect(meter?.storageGb).toBeCloseTo(10, 9);
    const days = await projectDays(t);
    expect(days.get(support)?.storageGb).toBeCloseTo(4, 9);
    expect(days.get(sales)?.storageGb).toBe(0);
  });
});

describe("projectUsage", () => {
  test("lists every project of the org, idle ones at zero, and none of another org's", async () => {
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const org = await seedOrg(t, "beeblast", ["Support bot", "Idle"]);
    const other = await seedOrg(t, "rival", ["Rival project"]);
    await record(t, org, { egressGb: 2 }, { projectId: org.projects[0] });
    await record(t, other, { egressGb: 5 }, { projectId: other.projects[0] });

    const projects = await readProjects(t, org, "2026-10");

    expect(projects.map((project) => project.name)).toEqual([
      "Idle",
      "Support bot",
    ]);
    const [idle, support] = projects;
    expect(support.totals).toEqual({
      sandboxHours: 0,
      hostedMcpHours: 0,
      storageGb: null,
      egressGb: 2,
      ingressGb: 0,
    });
    expect(support.days).toEqual([
      {
        day: "2026-10-16",
        sandboxHours: 0,
        hostedMcpHours: 0,
        storageGb: null,
        egressGb: 2,
        ingressGb: 0,
      },
    ]);
    expect(idle.totals.egressGb).toBe(0);
    expect(idle.days).toEqual([]);
  });

  test("sums the month's days and leaves out other months", async () => {
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const org = await seedOrg(t, "beeblast", ["Support bot"]);
    const source = { projectId: org.projects[0] };
    await record(t, org, { egressGb: 1 }, source, NOW - DAY_MS);
    await record(t, org, { egressGb: 2 }, source, NOW);
    await record(t, org, { egressGb: 7 }, source, Date.UTC(2026, 8, 30, 23));
    await record(t, org, { egressGb: 9 }, source, Date.UTC(2026, 10, 1));

    const [october] = await readProjects(t, org, "2026-10");
    const [september] = await readProjects(t, org, "2026-09");

    expect(october.totals.egressGb).toBe(3);
    expect(october.days.map((day) => [day.day, day.egressGb])).toEqual([
      ["2026-10-15", 1],
      ["2026-10-16", 2],
    ]);
    expect(september.totals.egressGb).toBe(7);
  });

  test("reads storage at the account's latest snapshot, 0 GB for a project it found nothing in", async () => {
    vi.useFakeTimers({ now: NOW });
    const t = meterTest();
    const org = await seedOrg(t, "beeblast", ["Support bot", "Sales"]);
    const [support, sales] = org.projects;
    const snapshot = async (
      at: number,
      gb: number,
      shares: Array<[Id<"projects">, number]>,
    ): Promise<void> => {
      await t.mutation(internal.account.budget.record, {
        accountId: org.accountId,
        usage: { storageGbMonths: gb / 30 },
        at: at,
        projectStorage: shares.map(([projectId, share]) => ({
          projectId: projectId,
          storageGbMonths: share / 30,
        })),
      });
    };
    // Sales held 3 GB yesterday; today its workspaces are gone, so the
    // snapshot sends no share for it.
    await snapshot(NOW - DAY_MS, 8, [
      [support, 4],
      [sales, 3],
    ]);
    await snapshot(NOW, 6, [[support, 5]]);

    const projects = await readProjects(t, org, "2026-10");
    const byId = new Map(projects.map((p) => [p.projectId, p]));

    expect(byId.get(support)?.totals.storageGb).toBeCloseTo(5, 9);
    expect(byId.get(sales)?.totals.storageGb).toBe(0);
    expect(
      byId.get(sales)?.days.map((day) => [day.day, day.storageGb]),
    ).toEqual([
      ["2026-10-15", 3],
      ["2026-10-16", 0],
    ]);
  });
});

describe("getForActiveOrg with projects", () => {
  test("refuses a caller who is not signed in", async () => {
    const t = meterTest();
    workosTest.register(t);

    await expect(
      t.query(api.account.budget.getForActiveOrg, { withProjects: true }),
    ).rejects.toThrow("not authenticated");
  });

  test("returns the caller's org's projects, and the current month for a month it cannot read", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
    const t = meterTest();
    workosTest.register(t);
    cronsComponent.register(t);
    await seedAuthUser(t);
    const caller = t.withIdentity({ subject: AUTH_ID });
    const orgId = await caller.mutation(api.org.orgs.create, {
      name: "Usage fixture",
    });
    const account = await t.mutation(internal.account.accounts.create, {
      orgId: orgId,
      username: "usage-fixture",
      secretHash: "hash",
    });
    const projectId = await t.run(async (ctx) =>
      ctx.db.insert("projects", {
        authId: AUTH_ID,
        orgId: orgId,
        name: "Support bot",
        slug: "support-bot",
        updatedAt: NOW,
      }),
    );
    await seedOrg(t, "rival", ["Rival project"]);
    await t.mutation(internal.account.budget.record, {
      accountId: account._id,
      usage: { egressGb: 2 },
      source: { projectId: projectId },
    });

    const split = await caller.query(api.account.budget.getForActiveOrg, {
      month: "October",
      withProjects: true,
    });
    const plain = await caller.query(api.account.budget.getForActiveOrg, {});

    expect(split?.month).toBe("2026-10");
    expect(split?.projects?.map((project) => project.name)).toEqual([
      "Support bot",
    ]);
    expect(split?.projects?.[0].totals.egressGb).toBe(2);
    expect(plain?.projects).toBeUndefined();
  });
});

async function seedOrg(
  t: T,
  slug: string,
  projectNames: string[],
): Promise<Org> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: slug,
      slug: slug,
      ownerAuthId: `auth_${slug}`,
      plan: "pro",
      createdAt: NOW,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: slug,
      secretHash: "hash",
      status: "active" as const,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const projects: Id<"projects">[] = [];
    for (const name of projectNames) {
      projects.push(
        await ctx.db.insert("projects", {
          authId: `auth_${slug}`,
          orgId: orgId,
          name: name,
          slug: name.toLowerCase().replaceAll(" ", "-"),
          updatedAt: NOW,
        }),
      );
    }

    return { orgId: orgId, accountId: accountId, projects: projects };
  });
}

async function seedAgentAndWorkspace(
  t: T,
  org: Org,
  projectId: Id<"projects">,
): Promise<{ agentId: Id<"agents">; workspaceId: Id<"workspaceConfigs"> }> {
  return await t.run(async (ctx) => {
    const stageId = await ctx.db.insert("stages", {
      authId: "auth",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: NOW,
    });
    const agentId = await ctx.db.insert("agents", {
      accountId: org.accountId,
      name: `agent-${projectId}`,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("agentConfigs", {
      authId: "auth",
      projectId: projectId,
      stageId: stageId,
      agentId: agentId,
      name: "Agent",
      updatedAt: NOW,
    });
    const workspaceId = await ctx.db.insert("workspaceConfigs", {
      accountId: org.accountId,
      projectId: projectId,
      stageId: stageId,
      name: "files",
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
    });

    return { agentId: agentId, workspaceId: workspaceId };
  });
}

async function record(
  t: T,
  org: Org,
  usage: { egressGb?: number; ingressGb?: number; hostedMcpRequests?: number },
  source: { projectId?: string; agentId?: string; workspaceId?: string },
  at?: number,
): Promise<void> {
  await t.mutation(internal.account.budget.record, {
    accountId: org.accountId,
    usage: usage,
    source: source,
    ...(at === undefined ? {} : { at: at }),
  });
}

async function projectDays(
  t: T,
): Promise<Map<Id<"projects">, { [key: string]: unknown }>> {
  const rows = await t.run(async (ctx) =>
    ctx.db.query("usageProjectDays").collect(),
  );

  return new Map(rows.map((row) => [row.projectId, row]));
}

async function readProjects(t: T, org: Org, month: string) {
  return await t.run(async (ctx) => {
    const account = await ctx.db.get(org.accountId);
    if (!account) throw new Error("account missing");

    return await projectUsage(
      ctx,
      account,
      await budgetUsage(ctx, account._id, NOW, month),
    );
  });
}

/** Seed AuthKit's verified user projection without replacing its getAuthUser implementation. */
async function seedAuthUser(t: T): Promise<void> {
  const now = new Date().toISOString();
  await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
    apiKey: "sk_test_fixture",
    event: {
      id: "evt_project_usage_signup",
      event: "user.created",
      createdAt: now,
      data: {
        id: AUTH_ID,
        email: "project-usage@example.invalid",
        emailVerified: true,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await t.run(async (ctx): Promise<void> => {
    await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "project-usage@example.invalid",
      name: "Project usage owner",
      plan: "pro",
    });
  });
}
