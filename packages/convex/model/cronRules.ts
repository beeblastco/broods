/**
 * Cron-job input normalization for the Convex config plane. Ports core's
 * former src/shared/domain/cron.ts normalizer so the public /v1/crons
 * contract is unchanged. Pure module — safe for the default Convex runtime;
 * schedule registration lives in agent/crons.ts and the public projections
 * in ./responses.ts.
 */

import { isPlainObject } from "./objects";

const TIMEZONE_PATTERN = /^[A-Za-z0-9_./+-]{1,64}$/;

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

/** A schedule the Convex crons component can register. */
export type ComponentCronSchedule =
  | { kind: "cron"; cronspec: string; tz?: string }
  | { kind: "interval"; ms: number };

/** A translated schedule: recurring for the component, or a one-time instant. */
export type TranslatedCronSchedule =
  | ComponentCronSchedule
  | { kind: "at"; timestamp: number };

/** Normalized create payload: `input`/`events` collapsed to a stored events list. */
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

/** Normalized update patch: clearable fields use null, run payload uses events. */
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

/**
 * Validate and normalize a create-cron request body.
 * @param input the raw request body
 * @returns the normalized create payload
 * @throws when a field is missing, malformed, or out of bounds
 */
export function normalizeCreateCronInput(input: unknown): NormalizedCronCreate {
  if (!isPlainObject(input)) throw new Error("Request body must be an object");

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

/**
 * Validate and normalize an update-cron request body.
 * @param input the raw request body
 * @returns the normalized patch, with null marking fields to clear
 * @throws when the patch is empty or a field is malformed
 */
export function normalizeUpdateCronInput(input: unknown): NormalizedCronUpdate {
  if (!isPlainObject(input)) throw new Error("Request body must be an object");
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
    throw new Error("Request body must include at least one cron job field");
  }

  return normalized;
}

/**
 * Translate a stored schedule expression — the public contract keeps the
 * `cron(...)` / `rate(...)` / `at(...)` forms — into what the Convex crons
 * component registers: a unix cronspec with an IANA `tz`, an interval in
 * milliseconds, or the epoch instant of a one-time job.
 * @param expression a normalized schedule expression
 * @param timezone optional IANA timezone the expression is evaluated in
 * @returns the translated schedule
 * @throws when the expression uses forms the scheduler does not support
 */
export function translateScheduleExpression(
  expression: string,
  timezone: string | undefined,
): TranslatedCronSchedule {
  const rate = /^rate\((\d+)\s+([a-z]+)\)$/.exec(expression);
  if (rate) {
    const unitMs = RATE_MS_PER_UNIT[rate[2] ?? ""];
    const count = Number(rate[1]);
    if (!unitMs || count < 1) {
      throw new Error(
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
    throw new Error(
      "scheduleExpression must use cron(...), rate(...), or at(...)",
    );
  }

  return {
    kind: "cron",
    cronspec: cronExpressionToCronspec((cron[1] ?? "").trim()),
    ...(timezone ? { tz: timezone } : {}),
  };
}

/**
 * Convert the six-field cron form — minute hour day-of-month month day-of-week
 * year — to the five-field unix cronspec the crons component parses. `?` maps
 * to `*`, and day-of-week numbers shift from 1-7 (1 = Sunday) to 0-6.
 * @throws for the calendar forms unix cron has no equivalent for (`L`, `W`,
 * `#`, or a constrained year)
 */
function cronExpressionToCronspec(fields: string): string {
  const parts = fields.split(/\s+/);
  if (parts.length !== 6) {
    throw new Error(
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
    throw new Error("cron(...) year field must be * — years cannot be pinned");
  }
  for (const field of [minute, hour, dayOfMonth, month, dayOfWeek]) {
    if (/[LW#]/i.test(field)) {
      throw new Error(`cron(...) does not support L, W, or # in '${field}'`);
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

/** Shift an AWS day-of-week field (1-7, 1 = Sunday) to unix cron's 0-6. */
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

/** Parses an AWS numeric day-of-week token (1-7, 1 = Sunday), or throws. */
function requireDayOfWeekNumber(token: string): number {
  const value = Number(token);
  if (!Number.isInteger(value) || value < 1 || value > 7) {
    throw new Error(
      `cron(...) day-of-week must be 1-7 (1 = Sunday) or SUN-SAT, got '${token}'`,
    );
  }

  return value;
}

/**
 * Resolve an `at(yyyy-mm-ddThh:mm:ss)` expression to an epoch instant. The
 * wall-clock time is read in `timezone` when given, UTC otherwise — the same
 * semantics EventBridge Scheduler applied.
 */
function atExpressionToTimestamp(
  expression: string,
  timezone: string | undefined,
): number {
  const match = /^at\((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\)$/.exec(
    expression,
  );
  if (!match) {
    throw new Error("at(...) must use the at(yyyy-mm-ddThh:mm:ss) form");
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
  if (Number.isNaN(asUtc)) throw new Error("at(...) date is not a valid time");
  if (!timezone) return asUtc;

  // Two passes pin the wall clock to the zone's offset at the target instant,
  // which the first guess (the UTC reading) can miss across a DST boundary.
  const adjusted = asUtc - timezoneOffsetMs(asUtc, timezone);

  return asUtc - timezoneOffsetMs(adjusted, timezone);
}

const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timezone` from UTC at `timestamp`, in milliseconds. */
function timezoneOffsetMs(timestamp: number, timezone: string): number {
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

/**
 * Whether a schedule fires exactly once. Single home for this rule — core
 * re-exports it from apps/core/src/shared/domain/cron.ts.
 * @param expression a normalized schedule expression
 * @returns true for an at(...) schedule
 */
export function isOneTimeSchedule(expression: string): boolean {
  return expression.startsWith("at(");
}

/**
 * Parse the ?limit= query value for run listings.
 * @param value the raw query value
 * @returns the parsed limit, or undefined when absent
 * @throws when the value is not an integer between 1 and 100
 */
export function parseCronRunsLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }

  return parsed;
}

/** Collapses a one-of `input`/`events` payload into the stored events list. */
function runPayloadToEvents(payload: {
  input?: unknown;
  events?: unknown;
}): unknown[] {
  const hasInput = payload.input !== undefined;
  const hasEvents = payload.events !== undefined;
  if (hasInput === hasEvents) {
    throw new Error("Provide exactly one of input or events");
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

/** Like runPayloadToEvents, but returns undefined when neither field is supplied (updates). */
function optionalRunPayloadToEvents(payload: {
  input?: unknown;
  events?: unknown;
}): unknown[] | undefined {
  if (payload.input === undefined && payload.events === undefined)
    return undefined;

  return runPayloadToEvents(payload);
}

function normalizeEvents(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("events must be a non-empty array of model messages");
  }

  return value;
}

function normalizeScheduleExpression(value: unknown): string {
  const expression = requireString(value, "scheduleExpression", 256);
  if (!/^(cron|rate|at)\(.+\)$/.test(expression)) {
    throw new Error(
      "scheduleExpression must use cron(...), rate(...), or at(...)",
    );
  }

  return expression;
}

function normalizeTimezone(value: unknown): string {
  const timezone = requireString(value, "timezone", 64);
  if (!TIMEZONE_PATTERN.test(timezone)) {
    throw new Error("timezone contains unsupported characters");
  }

  return timezone;
}

function normalizeCronStatus(value: unknown): CronStatus {
  if (value === "active" || value === "paused") return value;
  throw new Error("status must be active or paused");
}

function requireString(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (trimmed.length > maxLength)
    throw new Error(`${name} must be at most ${maxLength} characters`);

  return trimmed;
}

function optionalString(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength)
    throw new Error(`${name} must be at most ${maxLength} characters`);

  return trimmed.length > 0 ? trimmed : undefined;
}
