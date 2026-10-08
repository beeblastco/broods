/**
 * What a cron job's schedule means to a reader: when it fires next, and the
 * expression in words. Built on the same translation the Convex scheduler
 * registers with, so the dashboard never disagrees with the fire itself.
 */

import { translateScheduleExpression } from "@broods/convex/model/cronRules";
import { parseExpression } from "cron-parser";

const DAY_NAMES: Record<string, string> = {
  SUN: "Sundays",
  MON: "Mondays",
  TUE: "Tuesdays",
  WED: "Wednesdays",
  THU: "Thursdays",
  FRI: "Fridays",
  SAT: "Saturdays",
  "0": "Sundays",
  "1": "Mondays",
  "2": "Tuesdays",
  "3": "Wednesdays",
  "4": "Thursdays",
  "5": "Fridays",
  "6": "Saturdays",
  "7": "Sundays",
};

const UNIT_WORD: Record<number, string> = {
  60_000: "minute",
  3_600_000: "hour",
  86_400_000: "day",
};

interface Scheduled {
  scheduleExpression: string;
  timezone?: string;
  status: "active" | "paused";
  lastInvokedAt?: number;
  createdAt: number;
}

/**
 * The schedule in plain words: "Every hour", "Every day 09:00 UTC",
 * "Mondays 09:00 Europe/Amsterdam", "Once at Oct 9, 09:00". Anything the
 * words cannot carry falls back to the expression itself.
 */
export function describeSchedule(
  expression: string,
  timezone: string | undefined,
): string {
  let schedule: ReturnType<typeof translateScheduleExpression>;
  try {
    schedule = translateScheduleExpression(expression, timezone);
  } catch {
    return expression;
  }
  if (schedule.kind === "interval") {
    // Largest unit that divides the interval: 60 minutes reads as an hour.
    const unit = Object.entries(UNIT_WORD)
      .reverse()
      .find(([ms]) => schedule.ms % Number(ms) === 0);
    if (!unit) return expression;
    const count = schedule.ms / Number(unit[0]);

    return count === 1 ? `Every ${unit[1]}` : `Every ${count} ${unit[1]}s`;
  }
  if (schedule.kind === "at") {
    return `Once at ${new Date(schedule.timestamp).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })}`;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] =
    schedule.cronspec.split(" ");
  const zone = timezone ?? "UTC";
  if (!/^\d+$/.test(minute ?? "") || !/^\d+$/.test(hour ?? "")) {
    return expression;
  }
  const clock = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")} ${zone}`;
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every day ${clock}`;
  }
  const day = DAY_NAMES[(dayOfWeek ?? "").toUpperCase()];
  if (dayOfMonth === "*" && month === "*" && day) return `${day} ${clock}`;

  return expression;
}

/**
 * When the job fires next, or null while paused, after a one-time fire, or
 * for an expression the scheduler would reject. An interval counts from the
 * last fire, as the scheduler does, or from creation before the first.
 */
export function nextRunAt(cron: Scheduled, now: number): number | null {
  if (cron.status !== "active") return null;
  let schedule: ReturnType<typeof translateScheduleExpression>;
  try {
    schedule = translateScheduleExpression(
      cron.scheduleExpression,
      cron.timezone,
    );
  } catch {
    return null;
  }
  if (schedule.kind === "at") {
    return schedule.timestamp > now ? schedule.timestamp : null;
  }
  if (schedule.kind === "interval") {
    const anchor = cron.lastInvokedAt ?? cron.createdAt;
    const elapsed = Math.max(0, now - anchor);
    const fires = Math.floor(elapsed / schedule.ms) + 1;

    return anchor + fires * schedule.ms;
  }
  try {
    return parseExpression(schedule.cronspec, {
      currentDate: new Date(now),
      ...(schedule.tz ? { tz: schedule.tz } : { utc: true }),
    })
      .next()
      .getTime();
  } catch {
    return null;
  }
}

/** "in 2h 14m", "in 40s"; "now" once due. */
export function untilLabel(ts: number, now: number): string {
  const seconds = Math.floor((ts - now) / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);

  return `in ${days}d ${hours % 24}h`;
}
