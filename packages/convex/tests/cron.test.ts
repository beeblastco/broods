/// <reference types="vite/client" />
import cronsComponent from "@convex-dev/crons/test";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import { translateScheduleExpression } from "../model/cronRules";
import { cronSchedules } from "../model/cronSchedules";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const t = () => {
  const tt = convexTest(schema, modules);
  cronsComponent.register(tt);

  return tt;
};
type T = ReturnType<typeof t>;

describe("list", () => {
  test("returns only the named agent's jobs", async () => {
    const tt = t();
    const { accountId, agentId } = await seed(tt);

    expect(
      (
        await tt.query(internal.agent.crons.list, {
          accountId: accountId,
          agentId: agentId,
        })
      ).map((cron) => cron.name),
    ).toEqual(["mine"]);
    expect(
      (await tt.query(internal.agent.crons.list, { accountId: accountId }))
        .length,
    ).toBe(2);
  });
});

describe("run history", () => {
  test("a settled run keeps its first outcome", async () => {
    const tt = t();
    const { accountId, agentId } = await seed(tt);
    const cronId = await tt.run(async (ctx) => {
      const row = await ctx.db
        .query("crons")
        .withIndex("by_accountId_and_agentId", (q) =>
          q.eq("accountId", accountId).eq("agentId", agentId),
        )
        .first();

      return row!._id;
    });
    const runId = await tt.mutation(internal.agent.crons.createRun, {
      accountId: accountId,
      cronId: cronId,
      eventId: "event-1",
      conversationKey: "api:cron",
    });

    await tt.mutation(internal.agent.crons.completeRun, {
      accountId: accountId,
      cronId: cronId,
      runId: runId,
      result: "done",
    });
    await tt.mutation(internal.agent.crons.failRun, {
      accountId: accountId,
      cronId: cronId,
      runId: runId,
      error: "late throw",
    });

    expect(await tt.run((ctx) => ctx.db.get(runId))).toMatchObject({
      status: "completed",
      result: "done",
    });
  });
});

describe("translateScheduleExpression", () => {
  test("maps rate(...) to an interval", () => {
    expect(translateScheduleExpression("rate(2 hours)", undefined)).toEqual({
      kind: "interval",
      ms: 2 * 3_600_000,
    });
  });

  test("maps six-field cron(...) to a unix cronspec with tz", () => {
    expect(
      translateScheduleExpression("cron(0 9 * * ? *)", "Europe/Amsterdam"),
    ).toEqual({ kind: "cron", cronspec: "0 9 * * *", tz: "Europe/Amsterdam" });
    // AWS day-of-week 1-7 (1 = Sunday) shifts to unix 0-6; names pass through.
    expect(
      translateScheduleExpression("cron(30 8 ? * MON *)", undefined),
    ).toEqual({ kind: "cron", cronspec: "30 8 * * MON" });
    expect(
      translateScheduleExpression("cron(0 12 ? * 2-6 *)", undefined),
    ).toEqual({ kind: "cron", cronspec: "0 12 * * 1-5" });
  });

  test("rejects the calendar forms unix cron cannot express", () => {
    expect(() =>
      translateScheduleExpression("cron(0 9 L * ? *)", undefined),
    ).toThrow("does not support L, W, or #");
    expect(() =>
      translateScheduleExpression("cron(0 9 ? * 6#3 *)", undefined),
    ).toThrow("does not support L, W, or #");
    expect(() =>
      translateScheduleExpression("cron(0 9 * * ? 2027)", undefined),
    ).toThrow("year field must be *");
  });

  test("resolves at(...) in the given timezone", () => {
    expect(
      translateScheduleExpression("at(2027-01-01T09:00:00)", undefined),
    ).toEqual({ kind: "at", timestamp: Date.UTC(2027, 0, 1, 9) });
    // Amsterdam is UTC+1 in January: 09:00 local is 08:00 UTC.
    expect(
      translateScheduleExpression(
        "at(2027-01-01T09:00:00)",
        "Europe/Amsterdam",
      ),
    ).toEqual({ kind: "at", timestamp: Date.UTC(2027, 0, 1, 8) });
    // ...and UTC+2 in July under DST.
    expect(
      translateScheduleExpression(
        "at(2027-07-01T09:00:00)",
        "Europe/Amsterdam",
      ),
    ).toEqual({ kind: "at", timestamp: Date.UTC(2027, 6, 1, 7) });
  });
});

describe("create/update/remove", () => {
  test("create registers a component cron named by the row id", async () => {
    const tt = t();
    const { accountId, agentId } = await seed(tt);

    const created = (await tt.mutation(internal.agent.crons.create, {
      accountId: accountId,
      input: {
        name: "hourly",
        agentId: agentId,
        input: "run the report",
        scheduleExpression: "rate(1 hour)",
      },
    })) as { cronId: string };

    const registration = await tt.run((ctx) =>
      cronSchedules.get(ctx, { name: created.cronId }),
    );
    expect(registration?.schedule).toEqual({
      kind: "interval",
      ms: 3_600_000,
    });
    expect(registration?.args).toMatchObject({ cronId: created.cronId });
  });

  test("rejects a timezone Intl does not know, even on a paused job", async () => {
    const tt = t();
    const { accountId, agentId } = await seed(tt);

    await expect(
      tt.mutation(internal.agent.crons.create, {
        accountId: accountId,
        input: {
          name: "bad-zone",
          agentId: agentId,
          input: "never",
          scheduleExpression: "rate(1 hour)",
          timezone: "Not/AZone",
          status: "paused",
        },
      }),
    ).rejects.toThrow("timezone must be a valid IANA timezone");
  });

  test("create rolls the row back when the schedule is rejected", async () => {
    const tt = t();
    const { accountId, agentId } = await seed(tt);

    await expect(
      tt.mutation(internal.agent.crons.create, {
        accountId: accountId,
        input: {
          name: "pinned-year",
          agentId: agentId,
          input: "never",
          scheduleExpression: "cron(0 9 * * ? 2027)",
        },
      }),
    ).rejects.toThrow("year field must be *");

    const rows = await tt.query(internal.agent.crons.list, {
      accountId: accountId,
    });
    expect(rows.map((row) => row.name)).toEqual(["mine", "theirs"]);
  });

  test("pausing deletes the registration and resuming re-registers it", async () => {
    const tt = t();
    const { accountId, agentId } = await seed(tt);
    const created = (await tt.mutation(internal.agent.crons.create, {
      accountId: accountId,
      input: {
        name: "daily",
        agentId: agentId,
        input: "run",
        scheduleExpression: "cron(0 9 * * ? *)",
        timezone: "Europe/Amsterdam",
      },
    })) as { cronId: string };

    await tt.mutation(internal.agent.crons.update, {
      accountId: accountId,
      cronId: created.cronId,
      patch: { status: "paused" },
    });
    expect(
      await tt.run((ctx) => cronSchedules.get(ctx, { name: created.cronId })),
    ).toBeNull();

    await tt.mutation(internal.agent.crons.update, {
      accountId: accountId,
      cronId: created.cronId,
      patch: { status: "active" },
    });
    const registration = await tt.run((ctx) =>
      cronSchedules.get(ctx, { name: created.cronId }),
    );
    expect(registration?.schedule).toEqual({
      kind: "cron",
      cronspec: "0 9 * * *",
      tz: "Europe/Amsterdam",
    });
  });

  test("remove deletes the row and its registration together", async () => {
    const tt = t();
    const { accountId, agentId } = await seed(tt);
    const created = (await tt.mutation(internal.agent.crons.create, {
      accountId: accountId,
      input: {
        name: "doomed",
        agentId: agentId,
        input: "run",
        scheduleExpression: "rate(5 minutes)",
      },
    })) as { cronId: string };

    expect(
      await tt.mutation(internal.agent.crons.remove, {
        accountId: accountId,
        cronId: created.cronId,
      }),
    ).toBe(true);
    expect(
      await tt.run((ctx) => cronSchedules.get(ctx, { name: created.cronId })),
    ).toBeNull();
    expect(
      (await tt.query(internal.agent.crons.list, { accountId: accountId }))
        .map((row) => row.name)
        .sort(),
    ).toEqual(["mine", "theirs"]);
  });

  test("a one-time at(...) job schedules a run and cancels with the row", async () => {
    const tt = t();
    const { accountId, agentId } = await seed(tt);
    const created = (await tt.mutation(internal.agent.crons.create, {
      accountId: accountId,
      input: {
        name: "once",
        agentId: agentId,
        input: "run once",
        scheduleExpression: "at(2100-01-01T09:00:00)",
      },
    })) as { cronId: string };

    const row = await tt.run((ctx) =>
      ctx.db.get(created.cronId as Id<"crons">),
    );
    expect(row?.scheduledRunId).toBeDefined();
    expect(
      await tt.run((ctx) => cronSchedules.get(ctx, { name: created.cronId })),
    ).toBeNull();

    await tt.mutation(internal.agent.crons.remove, {
      accountId: accountId,
      cronId: created.cronId,
    });
    const scheduled = await tt.run((ctx) =>
      ctx.db.system.get(row!.scheduledRunId!),
    );
    expect(scheduled?.state.kind).toBe("canceled");
  });
});

/** One account whose two agents own one cron job each. */
describe("CLI cron delete", () => {
  test("deletes only the route stage's job of that name", async () => {
    const tt = t();
    const secret = "fp_secret_cron_delete";
    const { devCronId, prodCronId } = await tt.run(async (ctx) => {
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
        secretHash: await sha256Hex(secret),
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
      const cronIds: Id<"crons">[] = [];
      // Production first, so an account-wide first-match would pick its job.
      for (const [stageName, kind] of [
        ["Production", "production"],
        ["Development", "development"],
      ] as const) {
        const stageId = await ctx.db.insert("stages", {
          authId: "auth_owner",
          projectId: projectId,
          name: stageName,
          kind: kind,
          isDefault: kind === "development",
          updatedAt: now,
        });
        const agentId = await ctx.db.insert("agents", {
          accountId: accountId,
          name: `${kind}-agent`,
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("agentConfigs", {
          authId: "auth_owner",
          name: "planner",
          agentId: agentId,
          projectId: projectId,
          stageId: stageId,
          managedBy: "cli",
          updatedAt: now,
        });
        cronIds.push(
          await ctx.db.insert("crons", {
            accountId: accountId,
            name: "nightly",
            agentId: agentId,
            events: [],
            scheduleExpression: "rate(1 day)",
            status: "active",
            createdAt: now,
            updatedAt: now,
          }),
        );
      }

      return { prodCronId: cronIds[0]!, devCronId: cronIds[1]! };
    });

    const response = await tt.fetch(
      "/v1/account/projects/demo-app/stages/development/resources/cron/nightly",
      { method: "DELETE", headers: { Authorization: `Bearer ${secret}` } },
    );

    expect(response.status).toBeLessThan(300);
    const remaining = await tt.run(async (ctx) => ({
      dev: await ctx.db.get(devCronId),
      prod: await ctx.db.get(prodCronId),
    }));
    expect(remaining.dev).toBeNull();
    expect(remaining.prod).not.toBeNull();
  });
});

async function seed(
  tt: T,
): Promise<{ accountId: Id<"accounts">; agentId: Id<"agents"> }> {
  return await tt.run(async (ctx) => {
    const now = Date.now();
    const accountId = await ctx.db.insert("accounts", {
      orgId: "org-placeholder",
      username: "cron-test",
      secretHash: "hash",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const agentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "agent",
      createdAt: now,
      updatedAt: now,
    });
    const otherAgentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "other",
      createdAt: now,
      updatedAt: now,
    });
    for (const [name, owner] of [
      ["mine", agentId],
      ["theirs", otherAgentId],
    ] as const) {
      await ctx.db.insert("crons", {
        accountId: accountId,
        name: name,
        agentId: owner,
        events: [],
        scheduleExpression: "rate(1 day)",
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { accountId: accountId, agentId: agentId };
  });
}
