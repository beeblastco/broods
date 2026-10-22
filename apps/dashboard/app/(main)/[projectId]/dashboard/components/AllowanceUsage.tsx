"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { HelpMark } from "@/app/components/HelpMark";
import { Separator } from "@/app/components/ui/separator";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import {
  ALLOWANCE_ROWS,
  type AllowanceRow,
  BUDGET_LEVEL_TEXT,
  billingReset,
  type BudgetUsage,
  dailySeries,
  formatAmount,
  formatPercent,
  monthLabel,
  otherOrgsSlice,
  poolNote,
  projectSlices,
  type UsageSlice,
  usageSlices,
} from "@/app/lib/allowance";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { budgetLevel } from "@broods/convex/model/planLimits";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { UsageChart, UsageLegend } from "./UsageChart";

const DAY_SECONDS = 24 * 60 * 60;

/** Whose month the Resources show: one project's part of the org's, or every project's. */
export type AllowanceViewOf =
  | { scope: "project"; projectId: string }
  | { scope: "all" };

const OTHER_USAGE_HELP =
  "Usage no single project made: account-wide sandboxes and workspaces, chat attachments, skills and bundles, deleted projects, and anything metered before usage was split by project.";

/**
 * Resources: the org's month per resource against its caps, with a month
 * picker. A project's Usage tab shows its part of each cap; the org's Usage
 * page shows each project's part and a table of them. Clicking a row charts
 * that resource per day under the table. Holds the last month while another
 * loads, so the table and chart ease to it instead of dropping to a skeleton.
 */
export function AllowanceUsage({
  view,
}: {
  view: AllowanceViewOf;
}): React.JSX.Element {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const usage = useQuery(api.account.budget.getForActiveOrg, {
    month: month,
    withProjects: true,
  });
  const [held, setHeld] = useState<BudgetUsage | null | undefined>(usage);
  if (usage !== undefined && usage !== held) {
    setHeld(usage);
  }
  const budget = usage === undefined ? held : usage;

  // The current month leads `months`: leave `month` unset for it, so the
  // query keeps one set of args while the picker returns to it.
  function handleMonthChange(value: string): void {
    setMonth(value === budget?.months[0] ? undefined : value);
  }

  return (
    <AllowanceView
      budget={budget}
      view={view}
      month={month}
      onMonthChange={handleMonthChange}
    />
  );
}

/**
 * The Resources as drawn, from data: the live pages feed it from Convex, the
 * gallery from fixtures. `budget` undefined is still loading.
 */
export function AllowanceView({
  budget,
  view,
  month,
  onMonthChange,
}: {
  budget: BudgetUsage | null | undefined;
  view: AllowanceViewOf;
  month: string | undefined;
  onMonthChange: (month: string) => void;
}): React.JSX.Element {
  return (
    <section
      className="grid min-w-0 gap-3 *:min-w-0"
      data-allowance-scope={view.scope}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Resources</h2>
          {budget && (
            <span className="text-xs text-muted-foreground">
              {resetLabel(budget)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view.scope === "project" && (
            <Link
              href="/settings/org?tab=usage"
              className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
            >
              All projects →
            </Link>
          )}
          {budget && (
            <Select
              items={budget.months.map((option) => ({
                label: monthLabel(option),
                value: option,
              }))}
              value={month ?? budget.month}
              onValueChange={(value) => {
                if (value) onMonthChange(value);
              }}
            >
              <SelectTrigger size="sm" className="cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {budget.months.map((option) => (
                  <SelectItem key={option} value={option}>
                    {monthLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      {budget === undefined ? (
        <Skeleton className="h-96 rounded-lg" />
      ) : budget === null ? (
        <p className="text-sm text-muted-foreground">
          No account in this organization yet.
        </p>
      ) : (
        <ScopedAllowance budget={budget} view={view} />
      )}
    </section>
  );
}

/**
 * The caps per resource and a daily chart of the picked one. Each bar is the
 * owner's pool, what stops runs: this org's slices, then the faded part the
 * owner's other organizations used. For one project: its amount leads, and
 * the solid part of the bar is it and the grey part the other projects. For
 * every project: the bar is split by project, and a table of the projects
 * follows. The chart and the table stay this org's own.
 */
function ScopedAllowance({
  budget,
  view,
}: {
  budget: BudgetUsage;
  view: AllowanceViewOf;
}): React.JSX.Element {
  const [picked, setPicked] = useState<AllowanceRow>(ALLOWANCE_ROWS[0]);
  const projectCount = budget.projects?.length ?? 0;
  const slices = useMemo(
    () =>
      view.scope === "all"
        ? usageSlices(budget)
        : projectSlices(budget, view.projectId),
    [budget, view],
  );
  const pool = useMemo(() => otherOrgsSlice(budget), [budget]);
  // What each bar is cut into: this org's slices, then the other organizations'.
  const bars = useMemo(
    () => (pool ? [...slices, pool] : slices),
    [slices, pool],
  );
  const own = view.scope === "project" ? slices[0] : null;
  const legend = useMemo(
    () =>
      bars.map((slice) => ({
        key: slice.projectId ?? slice.name,
        label: slice.name,
        color: slice.color,
      })),
    [bars],
  );
  // One plain line: whose limits these are, then how to read a split bar.
  const notes = [
    poolNote(budget) ??
      (own
        ? projectCount > 1
          ? `Limits are shared by all ${projectCount} projects in this organization.`
          : "Limits are shared by every project in this organization."
        : null),
    own && projectCount > 1
      ? `The solid part of each bar is this project, the grey part the rest of the organization${pool ? ", the faded part the owner's other organizations" : ""}.`
      : null,
  ].filter((note): note is string => note !== null);

  return (
    <div className="grid gap-6 *:min-w-0">
      <div className="grid gap-2">
        {notes.length > 0 && (
          <p className="text-xs text-muted-foreground">{notes.join(" ")}</p>
        )}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Resource</TableHead>
                {own && (
                  <TableHead className="text-right">This project</TableHead>
                )}
                <TableHead className="text-right">This organization</TableHead>
                {pool && (
                  <TableHead className="text-right">
                    All organizations
                  </TableHead>
                )}
                <TableHead className="text-right">Limit</TableHead>
                <TableHead
                  className={cn("min-w-24", own ? "w-1/4" : "w-2/5")}
                />
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ALLOWANCE_ROWS.map((row) => (
                <AllowanceTableRow
                  key={row.key}
                  budget={budget}
                  row={row}
                  bars={bars}
                  pool={pool}
                  own={own}
                  active={row.key === picked.key}
                  onPick={() => setPicked(row)}
                />
              ))}
            </TableBody>
          </Table>
          <Separator />
          <DailyChart budget={budget} row={picked} slices={slices} />
          <UsageLegend series={legend} className="px-4 pb-3" />
        </div>
      </div>
      {!own && (
        <ProjectsTable budget={budget} slices={slices} picked={picked} />
      )}
    </div>
  );
}

// One resource: used, its cap, and how close the pool is to it, the bar cut
// into `bars`. With `own`, its amount leads. Ingress reads Free.
function AllowanceTableRow({
  budget,
  row,
  bars,
  pool,
  own,
  active,
  onPick,
}: {
  budget: BudgetUsage;
  row: AllowanceRow;
  bars: UsageSlice[];
  pool: UsageSlice | null;
  own: UsageSlice | null;
  active: boolean;
  onPick: () => void;
}): React.JSX.Element {
  const share = row.share === null ? null : budget.shares[row.share];
  const level = share === null ? null : budgetLevel(share);
  const cap =
    row.share === null || !budget.caps ? null : budget.caps[row.share];
  const pooled = budget.pool?.shared
    ? budget.pool.totals[row.key]
    : budget.totals[row.key];

  return (
    <TableRow
      tabIndex={0}
      aria-selected={active}
      data-state={active ? "selected" : undefined}
      className="cursor-pointer"
      onClick={onPick}
      onKeyDown={(event) => {
        // A press on a control inside the row, like its help mark, is that control's.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPick();
        }
      }}
    >
      <TableCell>
        <ResourceLabel row={row} />
      </TableCell>
      {own && (
        <TableCell className="text-right">
          <span className="font-medium tabular-nums">
            {formatAmount(own.totals[row.key], row.unit)}
          </span>
        </TableCell>
      )}
      <TableCell className="text-right">
        <span className={cn("tabular-nums", own && "text-muted-foreground")}>
          {formatAmount(budget.totals[row.key], row.unit)}
        </span>
      </TableCell>
      {pool && (
        <TableCell className="text-right">
          <span className="tabular-nums text-muted-foreground">
            {formatAmount(pooled, row.unit)}
          </span>
        </TableCell>
      )}
      <TableCell className="text-right">
        <span className="tabular-nums text-muted-foreground">
          {row.share === null
            ? "Free"
            : cap === null
              ? "No limit"
              : formatAmount(cap, row.unit)}
        </span>
      </TableCell>
      <TableCell>
        {share !== null && (
          <SplitBar
            share={share}
            total={pooled}
            parts={bars.map((slice) => ({
              key: slice.projectId ?? slice.name,
              amount: slice.totals[row.key],
              color: slice.color,
            }))}
          />
        )}
      </TableCell>
      <TableCell className="text-right">
        {share !== null && (
          <span
            className={cn("tabular-nums", level && BUDGET_LEVEL_TEXT[level])}
          >
            {formatPercent(share)}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * A row's color swatch, when it has one, name and help mark, as the first
 * cell of the allowance and plan tables.
 */
export function ResourceLabel({
  row,
}: {
  row: Pick<AllowanceRow, "label" | "help"> & { color?: string };
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      {row.color && (
        <span
          className="size-2 rounded-sm bg-(--series-color)"
          style={{ "--series-color": row.color }}
        />
      )}
      {row.label}
      {row.help && <HelpMark text={row.help} />}
    </span>
  );
}

/**
 * A cap's bar, `share` percent long, cut into each part's piece of `total`.
 * An unknown amount (a storage day no snapshot measured), in the total or in
 * any part, draws the bar as one piece.
 */
function SplitBar({
  share,
  total,
  parts,
}: {
  share: number;
  total: number | null;
  parts: Array<{ key: string; amount: number | null; color: string }>;
}): React.JSX.Element {
  // The split is unknown as soon as one part is: this org before its first
  // storage snapshot on a pool another org has measured.
  const known =
    total !== null && total > 0 && parts.every((part) => part.amount !== null);

  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className="flex h-full w-(--bar-width) gap-px overflow-hidden rounded-full"
        style={{ "--bar-width": `${Math.min(share, 100)}%` }}
      >
        {known ? (
          parts.map(({ key, amount, color }) =>
            amount !== null && amount > 0 ? (
              <div
                key={key}
                className="h-full w-(--bar-width) shrink-0 bg-(--series-color)"
                style={{
                  "--bar-width": `${(amount / total) * 100}%`,
                  "--series-color": color,
                }}
              />
            ) : null,
          )
        ) : (
          <div className="h-full w-full bg-foreground" />
        )}
      </div>
    </div>
  );
}

// The picked resource per day of the month, one stacked part per slice, in
// one unit from the tallest day.
function DailyChart({
  budget,
  row,
  slices,
}: {
  budget: BudgetUsage;
  row: AllowanceRow;
  slices: UsageSlice[];
}): React.JSX.Element {
  // UsageChart eases to each new rows array, so only rebuild on real change.
  const daily = useMemo(
    () => dailySeries(budget.month, slices, row.key),
    [budget.month, slices, row.key],
  );
  const series = useMemo(
    () =>
      slices.map((slice) => ({
        key: slice.projectId ?? slice.name,
        label: slice.name,
        color: slice.color,
      })),
    [slices],
  );
  const axisMax = Math.max(
    0,
    ...daily.rows.map((values) =>
      values.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    ),
  );
  const used = formatAmount(budget.totals[row.key], row.unit);
  const cap =
    row.share === null || !budget.caps ? null : budget.caps[row.share];

  return (
    <div className="grid gap-2 p-3">
      <div className="flex items-center justify-between gap-4 px-1 text-xs">
        <span className="text-foreground">{row.label} per day</span>
        <span className="tabular-nums text-muted-foreground">
          {cap === null ? used : `${used} of ${formatAmount(cap, row.unit)}`}
        </span>
      </div>
      <UsageChart
        kind="bars"
        height={150}
        tickCount={3}
        series={series}
        rows={daily.rows}
        bucketStarts={daily.bucketStarts}
        binSeconds={DAY_SECONDS}
        selected={null}
        formatAxis={(value) => formatAmount(value, row.unit, axisMax)}
        formatValue={(value) => formatAmount(value, row.unit)}
      />
    </div>
  );
}

/**
 * Each project's month side by side, busiest first on the picked resource,
 * with its part of the org's total of it. A project's name opens its own
 * Usage tab.
 */
function ProjectsTable({
  budget,
  slices,
  picked,
}: {
  budget: BudgetUsage;
  slices: UsageSlice[];
  picked: AllowanceRow;
}): React.JSX.Element {
  const total = budget.totals[picked.key];
  const sorted = [...slices].sort((a, b) => {
    // "Other usage" closes the list whatever it holds.
    if (a.projectId === null || b.projectId === null) {
      return a.projectId === null ? 1 : -1;
    }

    return (b.totals[picked.key] ?? 0) - (a.totals[picked.key] ?? 0);
  });

  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-semibold text-foreground">By project</h3>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              {ALLOWANCE_ROWS.map((row) => (
                <TableHead key={row.key} className="text-right">
                  {row.label}
                </TableHead>
              ))}
              <TableHead className="w-44">Share of {picked.label}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((slice) => {
              const amount = slice.totals[picked.key];
              // Null while storage has no snapshot this month: no share yet.
              const part =
                amount === null || total === null
                  ? null
                  : total > 0
                    ? (amount / total) * 100
                    : 0;

              return (
                <TableRow key={slice.projectId ?? slice.name}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2 shrink-0 rounded-sm bg-(--series-color)"
                        style={{ "--series-color": slice.color }}
                      />
                      {slice.projectId === null ? (
                        <>
                          <span className="text-muted-foreground">
                            {slice.name}
                          </span>
                          <HelpMark text={OTHER_USAGE_HELP} />
                        </>
                      ) : (
                        <Link
                          href={`/${slice.projectId}/dashboard?tab=usage`}
                          className="truncate hover:underline"
                        >
                          {slice.name}
                        </Link>
                      )}
                    </span>
                  </TableCell>
                  {ALLOWANCE_ROWS.map((row) => (
                    <TableCell key={row.key} className="text-right">
                      <span
                        className={cn(
                          "tabular-nums",
                          row.key !== picked.key && "text-muted-foreground",
                        )}
                      >
                        {formatAmount(slice.totals[row.key], row.unit)}
                      </span>
                    </TableCell>
                  ))}
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="h-full w-(--bar-width) rounded-full bg-(--series-color)"
                          style={{
                            "--bar-width": `${part ?? 0}%`,
                            "--series-color": slice.color,
                          }}
                        />
                      </span>
                      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                        {part === null ? "–" : formatPercent(part)}
                      </span>
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// "Resets Oct 1" for the current month, nothing for a past one or no limits.
function resetLabel(budget: BudgetUsage): string {
  if (!budget.enforced) return "No limits";

  return budget.month === budget.months[0]
    ? `Resets ${billingReset(budget.month)}`
    : "";
}
