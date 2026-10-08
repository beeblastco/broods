import { describe, expect, test } from "bun:test";
import {
  describeSchedule,
  nextRunAt,
  untilLabel,
} from "../app/lib/cronSchedule";

const HOUR = 60 * 60 * 1000;
// Wed Oct 7 2026 12:00 UTC.
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

function cron(
  expression: string,
  extra: Partial<Parameters<typeof nextRunAt>[0]> = {},
) {
  return {
    scheduleExpression: expression,
    status: "active" as const,
    createdAt: NOW - 10 * HOUR,
    ...extra,
  };
}

describe("describeSchedule", () => {
  test("puts the common shapes into words", () => {
    expect(describeSchedule("rate(1 hour)", undefined)).toBe("Every hour");
    expect(describeSchedule("rate(15 minutes)", undefined)).toBe(
      "Every 15 minutes",
    );
    expect(describeSchedule("cron(0 9 * * ? *)", undefined)).toBe(
      "Every day 09:00 UTC",
    );
    expect(describeSchedule("cron(30 9 ? * MON *)", "Europe/Amsterdam")).toBe(
      "Mondays 09:30 Europe/Amsterdam",
    );
    expect(describeSchedule("cron(0 9 ? * 2 *)", undefined)).toBe(
      "Mondays 09:00 UTC",
    );
  });

  test("a one-time job reads in its own zone", () => {
    expect(
      describeSchedule("at(2026-10-07T09:00:00)", "Europe/Amsterdam"),
    ).toBe("Once at Oct 7, 09:00 Europe/Amsterdam");
    expect(describeSchedule("at(2026-10-07T09:00:00)", undefined)).toBe(
      "Once at Oct 7, 09:00 UTC",
    );
  });

  test("falls back to the expression it cannot phrase", () => {
    expect(describeSchedule("cron(*/5 * * * ? *)", undefined)).toBe(
      "cron(*/5 * * * ? *)",
    );
    expect(describeSchedule("nonsense", undefined)).toBe("nonsense");
  });
});

describe("nextRunAt", () => {
  test("a paused job has no next run", () => {
    expect(nextRunAt(cron("rate(1 hour)", { status: "paused" }), NOW)).toBe(
      null,
    );
  });

  test("an interval counts from the last fire, else from creation", () => {
    expect(
      nextRunAt(
        cron("rate(1 hour)", { lastInvokedAt: NOW - 20 * 60_000 }),
        NOW,
      ),
    ).toBe(NOW + 40 * 60_000);
    expect(nextRunAt(cron("rate(3 hours)"), NOW)).toBe(NOW + 2 * HOUR);
  });

  test("a cron expression fires at its next wall-clock match", () => {
    expect(nextRunAt(cron("cron(0 9 * * ? *)"), NOW)).toBe(
      Date.UTC(2026, 9, 8, 9, 0, 0),
    );
    expect(nextRunAt(cron("cron(0 9 ? * MON *)"), NOW)).toBe(
      Date.UTC(2026, 9, 12, 9, 0, 0),
    );
  });

  test("a one-time job fires once, then has no next run", () => {
    expect(nextRunAt(cron("at(2026-10-07T13:00:00)"), NOW)).toBe(NOW + HOUR);
    expect(
      nextRunAt(
        cron("at(2026-10-07T11:00:00)", { lastInvokedAt: NOW - HOUR }),
        NOW,
      ),
    ).toBe(null);
  });

  test("a one-time job whose time passed unfired is due now", () => {
    expect(nextRunAt(cron("at(2026-10-07T11:00:00)"), NOW)).toBe(NOW);
  });
});

describe("untilLabel", () => {
  test("reads as a countdown", () => {
    expect(untilLabel(NOW + 30_000, NOW)).toBe("in 30s");
    expect(untilLabel(NOW + 2 * HOUR + 14 * 60_000, NOW)).toBe("in 2h 14m");
    expect(untilLabel(NOW - 1, NOW)).toBe("now");
  });
});
