import type { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { SERIES_COLORS } from "./usageChart";

// Display units for each amount unit, largest first, with how many make one
// of the amount's own unit. formatAmount picks the largest that reads >= 1.
const DISPLAY_UNITS: Record<
  AmountUnit,
  Array<{ label: string; perUnit: number }>
> = {
  hours: [
    { label: " h", perUnit: 1 },
    { label: " min", perUnit: 60 },
    { label: " s", perUnit: 3600 },
  ],
  gb: [
    { label: " GB", perUnit: 1 },
    { label: " MB", perUnit: 1000 },
    { label: " KB", perUnit: 1_000_000 },
  ],
};

/** The org's month of usage, caps and shares, as `api.account.budget.getForActiveOrg` returns it. */
export type BudgetUsage = NonNullable<
  FunctionReturnType<typeof api.account.budget.getForActiveOrg>
>;

export type UsageAmounts = BudgetUsage["totals"];

type UsageDay = BudgetUsage["days"][number];

/**
 * One part of the org's month: a project, or what no project used. `days`
 * holds the days it has a row for, like `BudgetUsage["days"]`.
 */
export interface UsageSlice {
  /** The project's id, or null for the part no project used. */
  projectId: string | null;
  name: string;
  color: string;
  totals: UsageAmounts;
  days: UsageDay[];
}

export type AmountUnit = "hours" | "gb";

// Amounts below this are float noise left from subtracting the projects from
// the org's total, not usage.
const NOISE = 1e-9;

/** The color of the part no project used, and of "other projects". */
export const OTHER_USAGE_COLOR = "var(--color-muted-foreground)";

/**
 * The org's month split into `projects` (all of `budget.projects` unless
 * given), each with a color kept in the projects' own order, then "Other
 * usage": the org's total less the projects (account-wide resources, deleted
 * projects, usage metered before projects were), left out when it is
 * nothing. A storage amount no snapshot measured stays null on every side.
 */
export function usageSlices(
  budget: BudgetUsage,
  projects: NonNullable<BudgetUsage["projects"]> = budget.projects ?? [],
): UsageSlice[] {
  const slices: UsageSlice[] = projects.map((project, index) => ({
    projectId: project.projectId,
    name: project.name,
    color: SERIES_COLORS[index % SERIES_COLORS.length],
    totals: project.totals,
    days: project.days,
  }));
  const byDay = slices.map(
    (slice) => new Map(slice.days.map((day) => [day.day, day])),
  );
  const other: UsageSlice = {
    projectId: null,
    name: "Other usage",
    color: OTHER_USAGE_COLOR,
    totals: remainder(
      budget.totals,
      slices.map((slice) => slice.totals),
    ),
    days: budget.days.map((day) => ({
      day: day.day,
      ...remainder(
        day,
        byDay.map((days) => days.get(day.day) ?? EMPTY_AMOUNTS),
      ),
    })),
  };
  const hasOther = Object.values(other.totals).some(
    (amount) => (amount ?? 0) > 0,
  );

  return hasOther ? [...slices, other] : slices;
}

/**
 * The org's month from one project: the project, colored as the foreground,
 * then every other project and what no project used as one grey part. A
 * project the org's list lacks (just created, or another org's) used nothing.
 */
export function projectSlices(
  budget: BudgetUsage,
  projectId: string,
): [UsageSlice, UsageSlice] {
  const mine = budget.projects?.find(
    (project) => project.projectId === projectId,
  ) ?? {
    projectId: projectId as Id<"projects">,
    name: "This project",
    totals: EMPTY_AMOUNTS,
    days: [],
  };
  const [own, ...rest] = usageSlices(budget, [mine]);
  const others = rest.at(0);

  return [
    { ...own, color: "var(--color-foreground)" },
    {
      projectId: null,
      name: "Other projects",
      color: OTHER_USAGE_COLOR,
      totals: others?.totals ?? EMPTY_AMOUNTS,
      days: others?.days ?? [],
    },
  ];
}

/** No usage of anything. */
export const EMPTY_AMOUNTS: UsageAmounts = {
  sandboxHours: 0,
  hostedMcpHours: 0,
  storageGb: 0,
  egressGb: 0,
  ingressGb: 0,
};

// `whole` less each of `parts`, never below zero. Storage is unknown when the
// whole or any part is.
function remainder(whole: UsageAmounts, parts: UsageAmounts[]): UsageAmounts {
  const left = (key: Exclude<keyof UsageAmounts, "storageGb">): number => {
    const rest = parts.reduce((sum, part) => sum - part[key], whole[key]);

    return rest > NOISE ? rest : 0;
  };
  const storage = parts.reduce<number | null>(
    (sum, part) =>
      sum === null || part.storageGb === null ? null : sum - part.storageGb,
    whole.storageGb,
  );

  return {
    sandboxHours: left("sandboxHours"),
    hostedMcpHours: left("hostedMcpHours"),
    storageGb: storage === null ? null : storage > NOISE ? storage : 0,
    egressGb: left("egressGb"),
    ingressGb: left("ingressGb"),
  };
}

/** Calendar month "YYYY-MM" as the UTC day it resets on, like "Oct 1". */
export function billingReset(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);

  return formatDay(Date.UTC(year, monthNumber, 1));
}

/**
 * One amount per day of the month for each of `sources`, zero where nothing
 * was used. A day after today, and a storage day without a snapshot, has no
 * value yet: it is null and its bar a gap, so it never reads as 0.
 */
export function dailySeries(
  month: string,
  sources: Array<{ days: UsageDay[] }>,
  key: keyof UsageAmounts,
  now: number = Date.now(),
): { bucketStarts: number[]; rows: Array<Array<number | null>> } {
  const [year, monthNumber] = month.split("-").map(Number);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const byDay = sources.map(
    (source) => new Map(source.days.map((day) => [day.day, day])),
  );
  const bucketStarts = Array.from({ length: dayCount }, (_, index) =>
    Date.UTC(year, monthNumber - 1, index + 1),
  );
  const rows = bucketStarts.map((start) => {
    const date = new Date(start).toISOString().slice(0, 10);

    return byDay.map((days) => {
      const day = days.get(date);
      if (!day) return key === "storageGb" || start > now ? null : 0;

      return day[key];
    });
  });

  return { bucketStarts: bucketStarts, rows: rows };
}

/**
 * An amount in the largest display unit where `scaleBy` reads >= 1: the value
 * itself in a table, the series max on a chart axis so ticks share a unit.
 * A nonzero amount too small to show reads "<0.01"; null reads "–".
 */
export function formatAmount(
  value: number | null,
  unit: AmountUnit,
  scaleBy: number | null = value,
): string {
  if (value === null) return "–";
  const units = DISPLAY_UNITS[unit];
  const shown =
    units.find(({ perUnit }) => (scaleBy ?? 0) * perUnit >= 1) ??
    units[scaleBy ? units.length - 1 : 0];
  const scaled = value * shown.perUnit;
  if (scaled > 0 && scaled < 0.01) return `<0.01${shown.label}`;

  return `${scaled.toLocaleString([], { maximumFractionDigits: scaled < 10 ? 2 : 1 })}${shown.label}`;
}

/** A UTC epoch as "Oct 1". */
export function formatDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** A share as a whole percent, "<1%" for a sliver so it never reads as none. */
export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";

  return `${Math.round(percent)}%`;
}

/** Calendar month "YYYY-MM" as "September 2026". */
export function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);

  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleDateString([], {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
