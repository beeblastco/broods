import type { CronInfo } from "@convex-dev/crons";
import { isPlainObject } from "./objects";
import { ClientError } from "./clientError";

const TIMEZONE_PATTERN = /^[A-Za-z0-9_./+-]{1,64}$/;
const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();

const RATE_MS_PER_UNIT: Record<string, number> = {
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
};

const DAY_OF_WEEK_NAMES = new Set([
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
]);

export type CronStatus = "active" | "paused";

export type ComponentCronSchedule = CronInfo["schedule"];

export type TranslatedCronSchedule =
  | ComponentCronSchedule
  | { kind: "at"; timestamp: number };

export interface NormalizedCronCreate {
  name: string;
  description?: string;
  agentId: string;
  events: unknown[];
  conversationKey?: string;
  scheduleExpression: string;
  timezone?: string;
  status?: CronStatus;
}

export interface NormalizedCronUpdate {
  name?: string;
  description?: string | null;
  agentId?: string;
  events?: unknown[];
  conversationKey?: string | null;
  scheduleExpression?: string;
  timezone?: string | null;
  status?: CronStatus;
}

export function normalizeCreateCronInput(input: unknown): NormalizedCronCreate {
  if (!isPlainObject(input))
    throw new ClientError("Request body must be an object");

  return {
    name: requireString(input.name, "name", 120),
    agentId: requireString(input.agentId, "agentId", 120),
    events: runPayloadToEvents(input),
    scheduleExpression: normalizeScheduleExpression(input.scheduleExpression),
    ...(input.description !== undefined
      ? {
          description:
            optionalString(input.description, "description", 500) ?? "",
        }
      : {}),
    ...(input.conversationKey !== undefined
      ? {
          conversationKey:
            optionalString(input.conversationKey, "conversationKey", 256) ?? "",
        }
      : {}),
    ...(input.timezone !== undefined
      ? { timezone: normalizeTimezone(input.timezone) }
      : {}),
    ...(input.status !== undefined
      ? { status: normalizeCronStatus(input.status) }
      : {}),
  };
}

export function normalizeUpdateCronInput(input: unknown): NormalizedCronUpdate {
  if (!isPlainObject(input))
    throw new ClientError("Request body must be an object");
  const events = optionalRunPayloadToEvents(input);
  const normalized: NormalizedCronUpdate = {
    ...(input.name !== undefined
      ? { name: requireString(input.name, "name", 120) }
      : {}),
    ...(input.description !== undefined
      ? {
          description:
            input.description === null
              ? null
              : optionalString(input.description, "description", 500),
        }
      : {}),
    ...(input.agentId !== undefined
      ? { agentId: requireString(input.agentId, "agentId", 120) }
      : {}),
    ...(events !== undefined ? { events: events } : {}),
    ...(input.conversationKey !== undefined
      ? {
          conversationKey:
            input.conversationKey === null
              ? null
              : optionalString(input.conversationKey, "conversationKey", 256),
        }
      : {}),
    ...(input.scheduleExpression !== undefined
      ? {
          scheduleExpression: normalizeScheduleExpression(
            input.scheduleExpression,
          ),
        }
      : {}),
    ...(input.timezone !== undefined
      ? {
          timezone:
            input.timezone === null ? null : normalizeTimezone(input.timezone),
        }
      : {}),
    ...(input.status !== undefined
      ? { status: normalizeCronStatus(input.status) }
      : {}),
  };
  if (Object.keys(normalized).length === 0) {
    throw new ClientError(
      "Request body must include at least one cron job field",
    );
  }

  return normalized;
}

export function translateScheduleExpression(
  expression: string,
  timezone: string | undefined,
): TranslatedCronSchedule {
  const rate = /^rate\((\d+)\s+([a-z]+)\)$/.exec(expression);
  if (rate) {
    const unitMs = RATE_MS_PER_UNIT[rate[2] ?? ""];
    const count = Number(rate[1]);
    if (!unitMs || count < 1) {
      throw new ClientError(
        "rate(...) must use a positive count of minutes, hours, or days",
      );
    }

    return { kind: "interval", ms: count * unitMs };
  }
  if (isOneTimeSchedule(expression)) {
    return {
      kind: "at",
      timestamp: atExpressionToTimestamp(expression, timezone),
    };
  }
  const cron = /^cron\((.+)\)$/.exec(expression);
  if (!cron) {
    throw new ClientError(
      "scheduleExpression must use cron(...), rate(...), or at(...)",
    );
  }

  return {
    kind: "cron",
    cronspec: cronExpressionToCronspec((cron[1] ?? "").trim()),
    ...(timezone ? { tz: timezone } : {}),
  };
}

export function isOneTimeSchedule(expression: string): boolean {
  return expression.startsWith("at(");
}

function atExpressionToTimestamp(
  expression: string,
  timezone: string | undefined,
): number {
  const match = /^at\((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\)$/.exec(
    expression,
  );
  if (!match) {
    throw new ClientError("at(...) must use the at(yyyy-mm-ddThh:mm:ss) form");
  }
  const [
    ,
    year = "",
    month = "",
    day = "",
    hour = "",
    minute = "",
    second = "",
  ] = match;
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (Number.isNaN(asUtc))
    throw new ClientError("at(...) date is not a valid time");
  if (!timezone) return asUtc;

  // A second pass takes the offset at the target instant, which the UTC guess misses across DST.
  const adjusted = asUtc - timezoneOffsetMs(asUtc, timezone);

  return asUtc - timezoneOffsetMs(adjusted, timezone);
}

// AWS day-of-week is 1-7 with 1 = Sunday; unix cron is 0-6.
function convertDayOfWeek(field: string): string {
  if (field === "?" || field === "*") return "*";

  return field
    .split(",")
    .map((item) =>
      item
        .split("-")
        .map((token) => {
          const [base, step] = token.split("/") as [string, string | undefined];
          const converted = DAY_OF_WEEK_NAMES.has(base.toUpperCase())
            ? base
            : String(requireDayOfWeekNumber(base) - 1);

          return step === undefined ? converted : `${converted}/${step}`;
        })
        .join("-"),
    )
    .join(",");
}

// AWS six-field cron to the unix cronspec, which has no year field and no `L`, `W` or `#`.
function cronExpressionToCronspec(fields: string): string {
  const parts = fields.split(/\s+/);
  if (parts.length !== 6) {
    throw new ClientError(
      "cron(...) must have six fields: minute hour day-of-month month day-of-week year",
    );
  }
  const [
    minute = "",
    hour = "",
    dayOfMonth = "",
    month = "",
    dayOfWeek = "",
    year = "",
  ] = parts;
  if (year !== "*") {
    throw new ClientError(
      "cron(...) year field must be *. Years cannot be pinned",
    );
  }
  for (const field of [minute, hour, dayOfMonth, month, dayOfWeek]) {
    if (/[LW#]/i.test(field)) {
      throw new ClientError(
        `cron(...) does not support L, W, or # in '${field}'`,
      );
    }
  }

  return [
    minute,
    hour,
    dayOfMonth === "?" ? "*" : dayOfMonth,
    month,
    convertDayOfWeek(dayOfWeek),
  ].join(" ");
}

function normalizeCronStatus(value: unknown): CronStatus {
  if (value === "active" || value === "paused") return value;
  throw new ClientError("status must be active or paused");
}

function normalizeEvents(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ClientError("events must be a non-empty array of model messages");
  }

  return value;
}

function normalizeScheduleExpression(value: unknown): string {
  const expression = requireString(value, "scheduleExpression", 256);
  if (!/^(cron|rate|at)\(.+\)$/.test(expression)) {
    throw new ClientError(
      "scheduleExpression must use cron(...), rate(...), or at(...)",
    );
  }

  return expression;
}

function normalizeTimezone(value: unknown): string {
  const timezone = requireString(value, "timezone", 64);
  if (!TIMEZONE_PATTERN.test(timezone)) {
    throw new ClientError("timezone contains unsupported characters");
  }
  try {
    timezoneFormatter(timezone);
  } catch {
    throw new ClientError("timezone must be a valid IANA timezone");
  }

  return timezone;
}

function optionalRunPayloadToEvents(payload: {
  input?: unknown;
  events?: unknown;
}): unknown[] | undefined {
  if (payload.input === undefined && payload.events === undefined)
    return undefined;

  return runPayloadToEvents(payload);
}

function optionalString(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new ClientError(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength)
    throw new ClientError(`${name} must be at most ${maxLength} characters`);

  return trimmed.length > 0 ? trimmed : undefined;
}

function requireDayOfWeekNumber(token: string): number {
  const value = Number(token);
  if (!Number.isInteger(value) || value < 1 || value > 7) {
    throw new ClientError(
      `cron(...) day-of-week must be 1-7 (1 = Sunday) or SUN-SAT, got '${token}'`,
    );
  }

  return value;
}

function requireString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== "string")
    throw new ClientError(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new ClientError(`${name} must be a non-empty string`);
  if (trimmed.length > maxLength)
    throw new ClientError(`${name} must be at most ${maxLength} characters`);

  return trimmed;
}

function runPayloadToEvents(payload: {
  input?: unknown;
  events?: unknown;
}): unknown[] {
  const hasInput = payload.input !== undefined;
  const hasEvents = payload.events !== undefined;
  if (hasInput === hasEvents) {
    throw new ClientError("Provide exactly one of input or events");
  }
  if (hasInput) {
    return [
      {
        role: "user",
        content: [{ type: "text", text: String(payload.input) }],
      },
    ];
  }

  return normalizeEvents(payload.events);
}

function timezoneFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = timezoneFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    timezoneFormatters.set(timezone, formatter);
  }

  return formatter;
}

function timezoneOffsetMs(timestamp: number, timezone: string): number {
  const formatter = timezoneFormatter(timezone);
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter.formatToParts(new Date(timestamp))) {
    parts[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return asUtc - timestamp;
}
