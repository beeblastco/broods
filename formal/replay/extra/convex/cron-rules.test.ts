import { describe, expect, test } from "bun:test";

import {
  normalizeCreateCronInput,
  normalizeUpdateCronInput,
  translateScheduleExpression,
} from "../../../../packages/convex/model/cronRules";

describe("translateScheduleExpression", () => {
  test.each([
    ["rate(5 minutes)", 300_000],
    ["rate(1 hour)", 3_600_000],
    ["rate(2 days)", 172_800_000],
  ])("%s is an interval", (expression: string, ms: number): void => {
    expect(translateScheduleExpression(expression, undefined)).toEqual({
      kind: "interval",
      ms: ms,
    });
  });

  test.each([
    ["cron(0 12 * * ? *)", "0 12 * * *"],
    ["cron(0 12 ? * 2 *)", "0 12 * * 1"],
    ["cron(0 12 ? * 1,7 *)", "0 12 * * 0,6"],
    ["cron(0 12 ? * 2-6 *)", "0 12 * * 1-5"],
    ["cron(0 12 ? * 2/2 *)", "0 12 * * 1/2"],
    ["cron(0 12 ? * MON-FRI *)", "0 12 * * MON-FRI"],
    ["cron(  0   12 1 * * * )", "0 12 1 * *"],
  ])("%s becomes a cronspec", (expression: string, spec: string): void => {
    expect(translateScheduleExpression(expression, undefined)).toEqual({
      kind: "cron",
      cronspec: spec,
    });
  });

  test("a cron keeps its timezone", (): void => {
    expect(
      translateScheduleExpression("cron(0 9 * * ? *)", "Asia/Tokyo"),
    ).toEqual({ kind: "cron", cronspec: "0 9 * * *", tz: "Asia/Tokyo" });
  });

  test.each([
    ["at(2026-01-02T03:04:05)", undefined, Date.UTC(2026, 0, 2, 3, 4, 5)],
    ["at(2026-01-02T12:00:00)", "Asia/Tokyo", Date.UTC(2026, 0, 2, 3, 0, 0)],
    [
      "at(2026-07-01T12:00:00)",
      "America/New_York",
      Date.UTC(2026, 6, 1, 16, 0, 0),
    ],
  ])(
    "%s in %s is one instant",
    (expression: string, zone: string | undefined, at: number): void => {
      expect(translateScheduleExpression(expression, zone)).toEqual({
        kind: "at",
        timestamp: at,
      });
    },
  );

  test.each([
    ["rate(0 minutes)", "positive count"],
    ["rate(5 weeks)", "positive count"],
    ["at(2026-01-02)", "yyyy-mm-dd"],
    ["daily", "must use cron"],
    ["cron(0 12 * * *)", "six fields"],
    ["cron(0 12 * * ? 2026)", "year field"],
    ["cron(0 12 L * ? *)", "does not support"],
    ["cron(0 12 ? * 2#1 *)", "does not support"],
    ["cron(0 12 ? * 8 *)", "day-of-week must be"],
    ["cron(0 12 ? * 0 *)", "day-of-week must be"],
    ["cron(0 12 ? * X *)", "day-of-week must be"],
  ])("%s is refused", (expression: string, message: string): void => {
    expect((): unknown =>
      translateScheduleExpression(expression, undefined),
    ).toThrow(message);
  });
});

describe("normalizeCreateCronInput", () => {
  test("trims fields and wraps input as a user message", (): void => {
    expect(
      normalizeCreateCronInput({
        name: " nightly ",
        agentId: " agent_1 ",
        input: "go",
        scheduleExpression: " rate(5 minutes) ",
        description: " about ",
        conversationKey: " key ",
        timezone: " Asia/Tokyo ",
        status: "paused",
      }),
    ).toEqual({
      name: "nightly",
      agentId: "agent_1",
      events: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      scheduleExpression: "rate(5 minutes)",
      description: "about",
      conversationKey: "key",
      timezone: "Asia/Tokyo",
      status: "paused",
    });
  });

  test("keeps events as given and omits absent options", (): void => {
    const events = [{ role: "user", content: "hi" }];
    expect(
      normalizeCreateCronInput({
        name: "n",
        agentId: "a",
        events: events,
        scheduleExpression: "cron(0 12 * * ? *)",
      }),
    ).toEqual({
      name: "n",
      agentId: "a",
      events: events,
      scheduleExpression: "cron(0 12 * * ? *)",
    });
  });

  test.each([
    ["both", { input: "x", events: [{}] }, "exactly one"],
    ["neither", {}, "exactly one"],
    ["bad timezone", { input: "x", timezone: "Mars/Base" }, "IANA"],
    ["bad characters", { input: "x", timezone: "a b" }, "unsupported"],
  ])(
    "refuses %s",
    (_name: string, extra: Record<string, unknown>, message: string): void => {
      expect((): unknown =>
        normalizeCreateCronInput({
          name: "n",
          agentId: "a",
          scheduleExpression: "rate(1 hour)",
          ...extra,
        }),
      ).toThrow(message);
    },
  );
});

describe("normalizeUpdateCronInput", () => {
  test("null clears, blank drops, and untouched fields stay out", (): void => {
    expect(
      normalizeUpdateCronInput({
        description: null,
        conversationKey: "   ",
        timezone: null,
      }),
    ).toEqual({ description: null, timezone: null });
  });

  test("an empty update is refused", (): void => {
    expect((): unknown => normalizeUpdateCronInput({})).toThrow(
      "at least one cron job field",
    );
  });
});
