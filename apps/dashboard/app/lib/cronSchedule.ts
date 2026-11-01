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
    const unit = Object.entries(UNIT_WORD)
      .reverse()
      .find(([ms]) => schedule.ms % Number(ms) === 0);
    if (!unit) return expression;
    const count = schedule.ms / Number(unit[0]);

    return count === 1 ? `Every ${unit[1]}` : `Every ${count} ${unit[1]}s`;
  }
  const zone = timezone ?? "UTC";
  if (schedule.kind === "at") {
    // Date and time are formatted apart: the joined form varies by ICU version.
    const at = new Date(schedule.timestamp);
    const day = at.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      timeZone: zone,
    });
    const clock = at.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: zone,
    });

    return `Once at ${day}, ${clock}`;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] =
    schedule.cronspec.split(" ");
  if (!/^\d+$/.test(minute ?? "") || !/^\d+$/.test(hour ?? "")) {
    return expression;
  }
  const clock = `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`;
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every day ${clock}`;
  }
  const day = DAY_NAMES[(dayOfWeek ?? "").toUpperCase()];
  if (dayOfMonth === "*" && month === "*" && day) return `${day} ${clock}`;

  return expression;
}

export function nextRunAt(cron: Scheduled, now: number): number | null {
  return cron.status === "active" ? nextFireAt(cron, now) : null;
}

export function nextFireAt(cron: Scheduled, now: number): number | null {
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
    if (schedule.timestamp > now) return schedule.timestamp;
    const fired =
      cron.lastInvokedAt !== undefined &&
      cron.lastInvokedAt >= schedule.timestamp;

    // A past time that never fired dispatches on resume, so it reads as due now.
    return fired ? null : now;
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
