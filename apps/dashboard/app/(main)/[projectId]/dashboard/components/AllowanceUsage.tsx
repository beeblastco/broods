"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { HelpMark } from "@/app/components/HelpMark";
import { SegmentedControl } from "@/app/components/SegmentedControl";
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
  billingReset,
  type AmountUnit,
  type BudgetUsage,
  dailySeries,
  formatAmount,
  formatPercent,
  monthLabel,
  projectSlices,
  type UsageAmounts,
  type UsageSlice,
  usageSlices,
} from "@/app/lib/allowance";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { useQuery } from "convex/react";
import Link from "next/link";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useMemo, useState } from "react";
import { UsageChart, UsageLegend } from "./UsageChart";

const DAY_SECONDS = 24 * 60 * 60;

export type AllowanceScope = "project" | "all";

const SCOPES: Array<{ id: AllowanceScope; label: string }> = [
  { id: "project", label: "This project" },
  { id: "all", label: "All projects" },
];

// The scope in the URL, so a link opens the same view.
const SCOPE_PARAM = parseAsStringLiteral(SCOPES.map((scope) => scope.id))
  .withDefault("project")
  .withOptions({ clearOnDefault: true });

// One row per resource. `share` names the cap it counts toward; ingress is
// free, so it has none. `help` says what the amount is counted from, where
// the label alone does not.
const ROWS: AllowanceRow[] = [
  {
    key: "sandboxHours",
    label: "Sandbox time",
    unit: "hours",
    share: "sandboxHours",
    color: "var(--color-usage-agent-sandbox)",
    help: "Hours your sandboxes spent running, idle time until they stop included, at the default 1 vCPU / 2 GB size. A bigger sandbox, a resume or a kept snapshot uses hours faster. An isolate counts only the seconds its commands ran. Sandboxes on your own provider account are free.",
  },
  {
    key: "hostedMcpHours",
    label: "Hosted MCP time",
    unit: "hours",
    share: "hostedMcpHours",
    color: "var(--color-usage-mcp-sandbox)",
    help: "Time your hosted MCP servers spent answering tool calls, at the runner's memory size, plus a small share per request. Idle servers cost nothing.",
  },
  {
    key: "storageGb",
    label: "Workspaces and files",
    unit: "gb",
    share: "storageGb",
    color: "var(--color-usage-storage)",
    help: "What the latest daily snapshot found stored in your workspaces, chat attachments, skills and bundles. A size, not a monthly total. A project counts its own workspaces; the rest is the organization's.",
  },
  {
    key: "egressGb",
    label: "Egress",
    unit: "gb",
    share: "egressGb",
    color: "var(--color-usage-egress)",
    help: "Data served out of Broods storage, such as media your agents sent to channels. Files on your own bucket are not counted.",
  },
  {
    key: "ingressGb",
    label: "Ingress",
    unit: "gb",
    share: null,
    color: "var(--color-usage-ingress)",
  },
];

const OTHER_USAGE_HELP =
  "Usage no single project made: account-wide sandboxes and workspaces, chat attachments, skills and bundles, deleted projects, and anything metered before usage was split by project.";

interface AllowanceRow {
  key: keyof UsageAmounts;
  label: string;
  unit: AmountUnit;
  share: keyof BudgetUsage["shares"] | null;
  color: string;
  help?: string;
}

/**
 * The Usage tab's Allowance: the org's month per resource against its caps,
 * with a month picker, seen from this project (its part of each cap) or from
 * all projects (each project's part, and a table of them). Clicking a row
 * charts that resource per day under the table. Holds the last month while
 * another loads, so the table and chart ease to it instead of dropping to a
 * skeleton first.
 */
export function AllowanceUsage({
  projectId,
}: {
  projectId: string;
}): React.JSX.Element {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [scope, setScope] = useQueryState("allowance", SCOPE_PARAM);
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
      projectId={projectId}
      scope={scope}
      onScopeChange={(next) => void setScope(next)}
      month={month}
      onMonthChange={handleMonthChange}
    />
  );
}

/**
 * The Allowance as drawn, from data: the live tab feeds it from Convex, the
 * gallery from fixtures. `budget` undefined is still loading.
 */
export function AllowanceView({
  budget,
  projectId,
  scope,
  onScopeChange,
  month,
  onMonthChange,
}: {
  budget: BudgetUsage | null | undefined;
  projectId: string;
  scope: AllowanceScope;
  onScopeChange: (scope: AllowanceScope) => void;
  month: string | undefined;
  onMonthChange: (month: string) => void;
}): React.JSX.Element {
  return (
    <section
      className="grid min-w-0 gap-3 *:min-w-0"
      data-allowance-scope={scope}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Allowance</h2>
          {budget && (
            <span className="text-xs text-muted-foreground">
              {resetLabel(budget)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            options={SCOPES}
            value={scope}
            onChange={onScopeChange}
            ariaLabel="Usage of"
          />
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
        <ScopedAllowance budget={budget} projectId={projectId} scope={scope} />
      )}
    </section>
  );
}

/**
 * The org's caps per resource and a daily chart of the picked one. From this
 * project: its amount leads, and each bar's solid part is it and the grey
 * part the other projects. From all projects: each bar is split by project,
 * and a table of the projects follows.
 */
function ScopedAllowance({
  budget,
  projectId,
  scope,
}: {
  budget: BudgetUsage;
  projectId: string;
  scope: AllowanceScope;
}): React.JSX.Element {
  const [picked, setPicked] = useState<AllowanceRow>(ROWS[0]);
  const projectCount = budget.projects?.length ?? 0;
  const slices = useMemo(
    () =>
      scope === "all" ? usageSlices(budget) : projectSlices(budget, projectId),
    [budget, projectId, scope],
  );
  const own = scope === "project" ? slices[0] : null;
  const legend = useMemo(
    () =>
      slices.map((slice) => ({
        key: slice.projectId ?? "other",
        label: slice.name,
        color: slice.color,
      })),
    [slices],
  );

  return (
    <div className="grid gap-6 *:min-w-0">
      <div className="grid gap-2">
        {own && (
          <p className="text-xs text-muted-foreground">
            {projectCount > 1
              ? `Limits are shared by all ${projectCount} projects in this organization. The solid part of each bar is this project, the grey part the rest of the organization.`
              : "Limits are shared by every project in this organization."}
          </p>
        )}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Resource</TableHead>
                {own && (
                  <TableHead className="text-right">This project</TableHead>
                )}
                <TableHead className="text-right">
                  {own ? "All projects" : "Used"}
                </TableHead>
                <TableHead className="text-right">Limit</TableHead>
                <TableHead
                  className={cn("min-w-24", own ? "w-1/4" : "w-2/5")}
                />
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map((row) => (
                <AllowanceTableRow
                  key={row.key}
                  budget={budget}
                  row={row}
                  slices={slices}
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
        <ProjectsTable
          budget={budget}
          slices={slices}
          picked={picked}
          projectId={projectId}
        />
      )}
    </div>
  );
}

// One resource: used, its cap, and how close it is, the bar split into the
// slices' parts. With `own`, its amount leads. Ingress reads Free.
function AllowanceTableRow({
  budget,
  row,
  slices,
  own,
  active,
  onPick,
}: {
  budget: BudgetUsage;
  row: AllowanceRow;
  slices: UsageSlice[];
  own: UsageSlice | null;
  active: boolean;
  onPick: () => void;
}): React.JSX.Element {
  const share = row.share === null ? null : budget.shares[row.share];
  const cap =
    row.share === null || !budget.caps ? null : budget.caps[row.share];

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
        <span className="flex items-center gap-2">
          <span
            className="size-2 rounded-sm bg-(--series-color)"
            style={{ "--series-color": row.color }}
          />
          {row.label}
          {row.help && <HelpMark text={row.help} />}
        </span>
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
            total={budget.totals[row.key]}
            parts={slices.map((slice) => ({
              key: slice.projectId ?? "other",
              amount: slice.totals[row.key],
              color: slice.color,
            }))}
          />
        )}
      </TableCell>
      <TableCell className="text-right">
        {share !== null && (
          <span
            className={cn(
              "tabular-nums",
              share < 80 && "text-muted-foreground",
              share >= 80 && share < 100 && "text-warning",
              share >= 100 && "text-destructive",
            )}
          >
            {formatPercent(share)}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * A cap's bar, `share` percent long, cut into each part's piece of `total`.
 * Unknown amounts (a storage day no snapshot measured) draw as one piece.
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
  const known = total !== null && total > 0;

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
        key: slice.projectId ?? "other",
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
  projectId,
}: {
  budget: BudgetUsage;
  slices: UsageSlice[];
  picked: AllowanceRow;
  projectId: string;
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
              {ROWS.map((row) => (
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
                <TableRow key={slice.projectId ?? "other"}>
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
                      {slice.projectId === projectId && (
                        <span className="text-2xs text-muted-foreground">
                          This project
                        </span>
                      )}
                    </span>
                  </TableCell>
                  {ROWS.map((row) => (
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
