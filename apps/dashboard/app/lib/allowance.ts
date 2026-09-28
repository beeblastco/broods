import type { api } from "@broods/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

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

export type AmountUnit = "hours" | "gb";

/** Calendar month "YYYY-MM" as the UTC day it resets on, like "Oct 1". */
export function billingReset(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);

  return formatDay(Date.UTC(year, monthNumber, 1));
}

/**
 * One amount per day of the month, zero where nothing was used. A day after
 * today, and a storage day without a snapshot, has no value yet: it is null
 * and its bar a gap, so it never reads as 0.
 */
export function dailySeries(
  budget: BudgetUsage,
  key: keyof BudgetUsage["totals"],
  now: number = Date.now(),
): { bucketStarts: number[]; rows: Array<Array<number | null>> } {
  const [year, monthNumber] = budget.month.split("-").map(Number);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const byDay = new Map(budget.days.map((day) => [day.day, day]));
  const bucketStarts = Array.from({ length: dayCount }, (_, index) =>
    Date.UTC(year, monthNumber - 1, index + 1),
  );
  const rows = bucketStarts.map((start): [number | null] => {
    const day = byDay.get(new Date(start).toISOString().slice(0, 10));
    if (!day) return [key === "storageGb" || start > now ? null : 0];

    return [day[key]];
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
