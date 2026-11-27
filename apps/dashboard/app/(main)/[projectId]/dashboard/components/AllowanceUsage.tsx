"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { HelpMark } from "@/app/components/HelpMark";
import { Button } from "@/app/components/ui/button";
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
import { tabHref } from "@/app/lib/navigation";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { budgetLevel } from "@broods/convex/model/planLimits";
import { useQuery } from "convex/react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { UsageChart, UsageLegend } from "./UsageChart";

const DAY_SECONDS = 24 * 60 * 60;

export type UsageScope =
  | { scope: "project"; projectId: string }
  | { scope: "all" };

const OTHER_USAGE_HELP =
  "Usage no single project made: account-wide sandboxes and workspaces, chat attachments, skills and bundles, deleted projects, and anything metered before usage was split by project.";

export function AllowanceUsage({
  view,
}: {
  view: UsageScope;
}): React.JSX.Element {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const usage = useQuery(api.account.budget.getForActiveOrg, {
    month: month,
    withProjects: true,
  });
  // The last month stays up while another loads, so the chart eases instead of blanking.
  const [held, setHeld] = useState<BudgetUsage | null | undefined>(usage);
  if (usage !== undefined && usage !== held) {
    setHeld(usage);
  }
  const budget = usage === undefined ? held : usage;

  // Unset for the current month (months[0]), so the query keeps one set of args for it.
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

export function AllowanceView({
  budget,
  view,
  month,
  onMonthChange,
}: {
  budget: BudgetUsage | null | undefined;
  view: UsageScope;
  month: string | undefined;
  onMonthChange: (month: string) => void;
}): React.JSX.Element {
  return (
    <section className="grid min-w-0 gap-3 *:min-w-0">
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
          {view.scope === "project" && (budget?.projects?.length ?? 0) > 1 && (
            <Button
              nativeButton={false}
              render={<Link href={tabHref("/settings/org", "usage", "")} />}
              size="xs"
              variant="ghost"
              className="cursor-pointer"
            >
              All projects
              <ArrowRight data-icon="inline-end" />
            </Button>
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
        <ResourcesTable budget={budget} view={view} />
      )}
    </section>
  );
}

function ResourcesTable({
  budget,
  view,
}: {
  budget: BudgetUsage;
  view: UsageScope;
}): React.JSX.Element {
  const [picked, setPicked] = useState<AllowanceRow>(ALLOWANCE_ROWS[0]);
  const projectCount = budget.projects?.length ?? 0;
  // Primitives, since callers pass a fresh `view` object every render.
  const projectId = view.scope === "project" ? view.projectId : null;
  const slices = useMemo(
    () =>
      projectId === null
        ? usageSlices(budget)
        : projectSlices(budget, projectId),
    [budget, projectId],
  );
  const pool = useMemo(() => otherOrgsSlice(budget), [budget]);
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
        // A key press on a control inside the row, like its help mark, is that control's.
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

function SplitBar({
  share,
  total,
  parts,
}: {
  share: number;
  total: number | null;
  parts: Array<{ key: string; amount: number | null; color: string }>;
}): React.JSX.Element {
  // One unknown part (a storage day no snapshot measured) leaves the split unknown.
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

function DailyChart({
  budget,
  row,
  slices,
}: {
  budget: BudgetUsage;
  row: AllowanceRow;
  slices: UsageSlice[];
}): React.JSX.Element {
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

function resetLabel(budget: BudgetUsage): string {
  if (!budget.enforced) return "No limits";

  return budget.month === budget.months[0]
    ? `Resets ${billingReset(budget.month)}`
    : "";
}
