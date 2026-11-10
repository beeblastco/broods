/// <reference types="vite/client" />
import cronsComponent from "@convex-dev/crons/test";
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import { translateScheduleExpression } from "../model/cronRules";
import { cronSchedules } from "../model/cronSchedules";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const STALE_AGE_MS = 10 * 60 * 1000;

const t = () => {
  const tt = convexTest(schema, modules);
  cronsComponent.register(tt);

  return tt;
};
type T = ReturnType<typeof t>;

describe("sweepDeadRuns", () => {
  test("fails a run whose envelope expired long ago, and shows it on the cron", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const runId = await staleRun(tt, accountId, cronId, "event-dead");
    await insertEnvelope(tt, accountId, "event-dead", "expired", HOUR_MS + 1);

    expect(await tt.mutation(internal.agent.crons.sweepDeadRuns, {})).toBe(1);

    expect(await tt.run((ctx) => ctx.db.get(runId))).toMatchObject({
      status: "failed",
      error: "The run stopped before it recorded an outcome.",
    });
    expect(await tt.run((ctx) => ctx.db.get(cronId))).toMatchObject({
      lastStatus: "failed",
    });
  });

  test("gives a worker that outlived its lease time to report", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const runId = await staleRun(tt, accountId, cronId, "event-long");
    await insertEnvelope(tt, accountId, "event-long", "expired", STALE_AGE_MS);

    expect(await tt.mutation(internal.agent.crons.sweepDeadRuns, {})).toBe(0);
    await tt.mutation(internal.agent.crons.completeRun, {
      accountId: accountId,
      cronId: cronId,
      runId: runId,
      result: "late",
    });

    expect(await tt.run((ctx) => ctx.db.get(runId))).toMatchObject({
      status: "completed",
    });
  });

  test("records a completed envelope's result when the settle was lost", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const runId = await staleRun(tt, accountId, cronId, "event-done");
    await insertEnvelope(
      tt,
      accountId,
      "event-done",
      "completed",
      STALE_AGE_MS,
      {
        result: "done",
      },
    );

    await tt.mutation(internal.agent.crons.sweepDeadRuns, {});

    expect(await tt.run((ctx) => ctx.db.get(runId))).toMatchObject({
      status: "completed",
      result: "done",
    });
  });

  test("leaves a live run, and one that ended moments ago, to settle itself", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const live = await staleRun(tt, accountId, cronId, "event-live");
    await insertEnvelope(
      tt,
      accountId,
      "event-live",
      "processing",
      STALE_AGE_MS,
    );
    const ending = await staleRun(tt, accountId, cronId, "event-ending");
    await insertEnvelope(tt, accountId, "event-ending", "completed", 1_000);

    expect(await tt.mutation(internal.agent.crons.sweepDeadRuns, {})).toBe(0);

    for (const runId of [live, ending]) {
      expect(await tt.run((ctx) => ctx.db.get(runId))).toMatchObject({
        status: "started",
      });
    }
  });

  test("waits on a paused run, then gives up on one nobody answers", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const waiting = await staleRun(tt, accountId, cronId, "event-wait");
    await insertEnvelope(
      tt,
      accountId,
      "event-wait",
      "completed",
      STALE_AGE_MS,
    );
    await insertPolling(tt, accountId, "event-wait");
    const abandoned = await staleRun(
      tt,
      accountId,
      cronId,
      "event-gone",
      8 * DAY_MS,
    );
    await insertEnvelope(
      tt,
      accountId,
      "event-gone",
      "completed",
      STALE_AGE_MS,
    );
    await insertPolling(tt, accountId, "event-gone");

    expect(await tt.mutation(internal.agent.crons.sweepDeadRuns, {})).toBe(1);

    expect(await tt.run((ctx) => ctx.db.get(waiting))).toMatchObject({
      status: "started",
    });
    expect(await tt.run((ctx) => ctx.db.get(abandoned))).toMatchObject({
      status: "failed",
      error: "The run waited for an approval or an answer that never came.",
    });
  });

  test("ends a row with no envelope id only once it is a day old", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const recent = await staleRun(tt, accountId, cronId, undefined);
    const old = await staleRun(tt, accountId, cronId, undefined, DAY_MS + 1);

    await tt.mutation(internal.agent.crons.sweepDeadRuns, {});

    expect(await tt.run((ctx) => ctx.db.get(recent))).toMatchObject({
      status: "started",
    });
    expect(await tt.run((ctx) => ctx.db.get(old))).toMatchObject({
      status: "failed",
    });
  });

  test("pages past live rows to reach a dead run behind them", async () => {
    vi.useFakeTimers();
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    for (let i = 0; i < 100; i += 1) {
      await staleRun(
        tt,
        accountId,
        cronId,
        `live-${i}`,
        STALE_AGE_MS + 1_000 + i,
      );
      await insertEnvelope(
        tt,
        accountId,
        `live-${i}`,
        "processing",
        STALE_AGE_MS,
      );
    }
    const dead = await staleRun(tt, accountId, cronId, "event-behind");
    await insertEnvelope(tt, accountId, "event-behind", "expired", HOUR_MS + 1);

    await tt.mutation(internal.agent.crons.sweepDeadRuns, {});
    await tt.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    expect(await tt.run((ctx) => ctx.db.get(dead))).toMatchObject({
      status: "failed",
    });
  });

  test("pages through one window, so the cursor stays valid for the next page", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    for (let i = 0; i <= 100; i += 1) {
      await staleRun(tt, accountId, cronId, undefined);
    }

    await tt.mutation(internal.agent.crons.sweepDeadRuns, {});
    const scheduled = await tt.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );

    expect(
      scheduled.find((job) => job.name.includes("sweepDeadRuns"))?.args[0],
    ).toMatchObject({ now: expect.any(Number) });
  });

  test("retires a job only when the dead run fired it as one-time", async () => {
    vi.useFakeTimers();
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    await staleRun(tt, accountId, cronId, "event-edited");
    await insertEnvelope(tt, accountId, "event-edited", "expired", HOUR_MS + 1);
    await tt.run((ctx) =>
      ctx.db.patch(cronId, { scheduleExpression: "at(2100-01-01T09:00:00)" }),
    );

    await tt.mutation(internal.agent.crons.sweepDeadRuns, {});
    await tt.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await tt.run((ctx) => ctx.db.get(cronId))).not.toBeNull();

    await staleRun(tt, accountId, cronId, "event-once");
    await insertEnvelope(tt, accountId, "event-once", "expired", HOUR_MS + 1);
    await tt.mutation(internal.agent.crons.sweepDeadRuns, {});
    await tt.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    expect(await tt.run((ctx) => ctx.db.get(cronId))).toBeNull();
  });
});

describe("settleAnsweredRun", () => {
  test("ends the paused run with the outcome of the turn that answered it", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const runId = await pausedRun(tt, accountId, cronId, "event-paused");

    await answer(tt, "approval-event-paused");

    expect(await tt.run((ctx) => ctx.db.get(runId))).toMatchObject({
      status: "completed",
      result: "approved and done",
    });
    expect(
      await tt.run((ctx) => ctx.db.query("cronRunWaits").collect()),
    ).toEqual([]);
  });

  test("finds the run that asked behind more than 100 newer paused runs", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const oldest = await pausedRun(tt, accountId, cronId, "event-0");
    for (let fire = 1; fire <= 101; fire += 1) {
      await pausedRun(tt, accountId, cronId, `event-${fire}`);
    }

    await answer(tt, "approval-event-0");

    expect(await tt.run((ctx) => ctx.db.get(oldest))).toMatchObject({
      status: "completed",
    });
  });

  test("an answer settles a run paused before waitingOn existed", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const runId = await staleRun(tt, accountId, cronId, "event-legacy");
    await tt.run((ctx) =>
      ctx.db.patch(runId, {
        ingressConversationKey: "scoped:cron",
        waitingOn: undefined,
      }),
    );

    await answer(tt, "approval-legacy");

    expect(await tt.run((ctx) => ctx.db.get(runId))).toMatchObject({
      status: "completed",
    });
  });
});

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
  test("a settled run keeps its first outcome, and a drained run settles as a no-op", async () => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const runId = await startRun(tt, accountId, cronId, 1_000);

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

    await tt.run((ctx) => ctx.db.delete(runId));
    await expect(
      tt.mutation(internal.agent.crons.failRun, {
        accountId: accountId,
        cronId: cronId,
        runId: runId,
        error: "after the drain",
      }),
    ).resolves.toBeNull();
  });

  test("an older run settling late leaves the newer run's status on the cron", async (): Promise<void> => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const older = await startRun(tt, accountId, cronId, 1_000);
    const newer = await startRun(tt, accountId, cronId, 2_000);

    await tt.mutation(internal.agent.crons.completeRun, {
      accountId: accountId,
      cronId: cronId,
      runId: newer,
      result: "done",
    });
    await tt.mutation(internal.agent.crons.failRun, {
      accountId: accountId,
      cronId: cronId,
      runId: older,
      error: "already processing another turn",
    });

    const cron = await tt.run((ctx) => ctx.db.get(cronId));
    expect(cron).toMatchObject({ lastRunId: newer, lastStatus: "completed" });
    expect(cron?.lastError).toBeUndefined();
  });

  test("a run settling after a refused fire leaves the refusal on the cron", async (): Promise<void> => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const runId = await startRun(tt, accountId, cronId, 1_000);

    await tt.mutation(internal.agent.crons.recordFailedFire, {
      accountId: accountId,
      cronId: cronId,
      error: "monthly compute allowance used",
      firedAt: 2_000,
    });
    await tt.mutation(internal.agent.crons.completeRun, {
      accountId: accountId,
      cronId: cronId,
      runId: runId,
      result: "done",
    });

    expect(await tt.run((ctx) => ctx.db.get(cronId))).toMatchObject({
      lastStatus: "failed",
      lastError: "monthly compute allowance used",
    });
  });

  test("an older fire refused late leaves the newer run on the cron", async (): Promise<void> => {
    const tt = t();
    const { accountId, cronId } = await firstCron(tt);
    const runId = await startRun(tt, accountId, cronId, 2_000);

    await tt.mutation(internal.agent.crons.recordFailedFire, {
      accountId: accountId,
      cronId: cronId,
      error: "monthly compute allowance used",
      firedAt: 1_000,
    });
    await tt.mutation(internal.agent.crons.completeRun, {
      accountId: accountId,
      cronId: cronId,
      runId: runId,
      result: "done",
    });

    expect(await tt.run((ctx) => ctx.db.get(cronId))).toMatchObject({
      lastRunId: runId,
      lastStatus: "completed",
      lastInvokedAt: 2_000,
    });
  });
});

describe("agent delete", () => {
  test("deleting an agent takes its crons and leaves the others", async (): Promise<void> => {
    const tt = t();
    const { accountId, agentId } = await seed(tt);

    await tt.mutation(internal.agent.agents.remove, {
      accountId: accountId,
      agentId: agentId,
    });

    expect(
      (await tt.query(internal.agent.crons.list, { accountId: accountId })).map(
        (cron): string => cron.name,
      ),
    ).toEqual(["theirs"]);
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

describe("CLI cron delete", () => {
  test("deletes only the route stage's job of that name", async () => {
    const tt = t();
    const secret = "bask_secret_cron_delete";
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

async function answer(tt: T, approvalId: string): Promise<void> {
  await tt.mutation(internal.agent.crons.settleAnsweredRun, {
    conversationKey: "scoped:cron",
    ownerEventId: `answer-${approvalId}`,
    answered: [approvalId],
    status: "completed",
    result: "approved and done",
  });
}

async function firstCron(
  tt: T,
): Promise<{ accountId: Id<"accounts">; cronId: Id<"crons"> }> {
  const { accountId, agentId } = await seed(tt);
  const [cron] = await tt.query(internal.agent.crons.list, {
    accountId: accountId,
    agentId: agentId,
  });

  return { accountId: accountId, cronId: cron!._id };
}

// A run whose own turn paused on the approval `approval-<ingressEventId>`.
async function pausedRun(
  tt: T,
  accountId: Id<"accounts">,
  cronId: Id<"crons">,
  ingressEventId: string,
): Promise<Id<"cronRuns">> {
  const runId = await staleRun(tt, accountId, cronId, ingressEventId);
  await tt.run((ctx) =>
    ctx.db.patch(runId, { ingressConversationKey: "scoped:cron" }),
  );
  await tt.mutation(internal.agent.crons.settleAnsweredRun, {
    conversationKey: "scoped:cron",
    ownerEventId: ingressEventId,
    answered: [],
    waitingOn: [`approval-${ingressEventId}`],
    status: "completed",
    result: { status: "awaiting_approval" },
  });

  return runId;
}

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

async function insertEnvelope(
  tt: T,
  accountId: Id<"accounts">,
  eventId: string,
  status: "completed" | "expired" | "processing",
  ageMs: number,
  extra: { result?: string } = {},
): Promise<void> {
  const updatedAt = Date.now() - ageMs;
  await tt.run((ctx) =>
    ctx.db.insert("runtimeIngressEnvelopes", {
      accountId: accountId,
      agentId: "agent",
      conversationKey: "api:cron",
      sequence: 1,
      eventId: eventId,
      runId: `run-${eventId}`,
      identity: "cron",
      idempotencyKey: eventId,
      payloadDigest: "digest",
      events: [],
      delivery: {
        kind: "http",
        publicEventId: eventId,
        publicConversationKey: "api:cron",
      },
      requestedMode: "reject",
      status: status,
      sizeBytes: 0,
      createdAt: updatedAt,
      updatedAt: updatedAt,
      expiresAt: updatedAt,
      statusExpiresAt: updatedAt + DAY_MS,
      ...extra,
    }),
  );
}

async function insertPolling(
  tt: T,
  accountId: Id<"accounts">,
  eventId: string,
): Promise<void> {
  await tt.run((ctx) =>
    ctx.db.insert("runtimeAsyncAgentResults", {
      accountId: accountId,
      eventId: eventId,
      conversationKey: "api:cron",
      status: "awaiting_approval",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      expiresAt: 4_000_000_000,
    }),
  );
}

// A run old enough for the sweep to read.
async function staleRun(
  tt: T,
  accountId: Id<"accounts">,
  cronId: Id<"crons">,
  ingressEventId: string | undefined,
  ageMs: number = STALE_AGE_MS,
): Promise<Id<"cronRuns">> {
  const runId = await startRun(tt, accountId, cronId, Date.now());
  await tt.run((ctx) =>
    ctx.db.patch(runId, {
      ingressEventId: ingressEventId,
      startedAt: Date.now() - ageMs,
    }),
  );

  return runId;
}

async function startRun(
  tt: T,
  accountId: Id<"accounts">,
  cronId: Id<"crons">,
  firedAt: number,
): Promise<Id<"cronRuns">> {
  return await tt.mutation(internal.agent.crons.createRun, {
    accountId: accountId,
    cronId: cronId,
    eventId: `event-${firedAt}`,
    conversationKey: "api:cron",
    firedAt: firedAt,
  });
}
