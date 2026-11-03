import type { CronInfo } from "@convex-dev/crons";
import { z } from "zod/mini";

import { ClientError } from "./clientError";
import { parseInput } from "./inputSchema";

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

const NAME = cronText(120, true);
const DESCRIPTION = cronText(500, false);
const CONVERSATION_KEY = cronText(256, false);
const SCHEDULE_EXPRESSION = cronText(256, true).check(
  z.refine((value): boolean => /^(cron|rate|at)\(.+\)$/.test(value.trim()), {
    error: "must use cron(...), rate(...), or at(...)",
  }),
);
const TIMEZONE = cronText(64, true).check(
  z.refine((value): boolean => TIMEZONE_PATTERN.test(value.trim()), {
    error: "contains unsupported characters",
  }),
  z.refine(isTimezone, { error: "must be a valid IANA timezone" }),
);
const CRON_STATUS = z.enum(["active", "paused"], {
  error: "must be active or paused",
});
const CRON_RUN = {
  input: z.optional(z.unknown()),
  events: z.optional(
    z
      .array(z.unknown(), {
        error: "must be a non-empty array of model messages",
      })
      .check(
        z.minLength(1, {
          error: "must be a non-empty array of model messages",
        }),
      ),
  ),
};
const CREATE_CRON_INPUT = z.looseObject(
  {
    name: NAME,
    agentId: NAME,
    ...CRON_RUN,
    scheduleExpression: SCHEDULE_EXPRESSION,
    description: z.optional(DESCRIPTION),
    conversationKey: z.optional(CONVERSATION_KEY),
    timezone: z.optional(TIMEZONE),
    status: z.optional(CRON_STATUS),
  },
  { error: "Request body must be an object" },
);
const UPDATE_CRON_INPUT = z.looseObject(
  {
    name: z.optional(NAME),
    description: z.optional(z.nullable(DESCRIPTION)),
    agentId: z.optional(NAME),
    ...CRON_RUN,
    conversationKey: z.optional(z.nullable(CONVERSATION_KEY)),
    scheduleExpression: z.optional(SCHEDULE_EXPRESSION),
    timezone: z.optional(z.nullable(TIMEZONE)),
    status: z.optional(CRON_STATUS),
  },
  { error: "Request body must be an object" },
);

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
  const cron = parseInput(CREATE_CRON_INPUT, input, "");

  return {
    name: cron.name.trim(),
    agentId: cron.agentId.trim(),
    events: runPayloadToEvents(cron),
    scheduleExpression: cron.scheduleExpression.trim(),
    ...(cron.description !== undefined
      ? { description: cron.description.trim() }
      : {}),
    ...(cron.conversationKey !== undefined
      ? { conversationKey: cron.conversationKey.trim() }
      : {}),
    ...(cron.timezone !== undefined ? { timezone: cron.timezone.trim() } : {}),
    ...(cron.status !== undefined ? { status: cron.status } : {}),
  };
}

export function normalizeUpdateCronInput(input: unknown): NormalizedCronUpdate {
  const cron = parseInput(UPDATE_CRON_INPUT, input, "");
  const events =
    cron.input === undefined && cron.events === undefined
      ? undefined
      : runPayloadToEvents(cron);
  const normalized: NormalizedCronUpdate = {
    ...(cron.name !== undefined ? { name: cron.name.trim() } : {}),
    ...(cron.description !== undefined
      ? {
          description:
            cron.description === null
              ? null
              : cron.description.trim() || undefined,
        }
      : {}),
    ...(cron.agentId !== undefined ? { agentId: cron.agentId.trim() } : {}),
    ...(events !== undefined ? { events: events } : {}),
    ...(cron.conversationKey !== undefined
      ? {
          conversationKey:
            cron.conversationKey === null
              ? null
              : cron.conversationKey.trim() || undefined,
        }
      : {}),
    ...(cron.scheduleExpression !== undefined
      ? { scheduleExpression: cron.scheduleExpression.trim() }
      : {}),
    ...(cron.timezone !== undefined
      ? { timezone: cron.timezone === null ? null : cron.timezone.trim() }
      : {}),
    ...(cron.status !== undefined ? { status: cron.status } : {}),
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

function requireDayOfWeekNumber(token: string): number {
  const value = Number(token);
  if (!Number.isInteger(value) || value < 1 || value > 7) {
    throw new ClientError(
      `cron(...) day-of-week must be 1-7 (1 = Sunday) or SUN-SAT, got '${token}'`,
    );
  }

  return value;
}

function runPayloadToEvents(payload: {
  input?: unknown;
  events?: unknown[];
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

  return payload.events ?? [];
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

function cronText(maxLength: number, required: boolean): z.ZodMiniString {
  return z.string().check(
    z.refine((value): boolean => !required || value.trim().length > 0, {
      error: "must be a non-empty string",
    }),
    z.refine((value): boolean => value.trim().length <= maxLength, {
      error: `must be at most ${maxLength} characters`,
    }),
  );
}

function isTimezone(value: string): boolean {
  try {
    timezoneFormatter(value.trim());

    return true;
  } catch {
    return false;
  }
}
