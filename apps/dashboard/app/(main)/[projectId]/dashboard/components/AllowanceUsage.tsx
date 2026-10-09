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
  billingReset,
  type AmountUnit,
  type BudgetUsage,
  dailySeries,
  formatAmount,
  formatPercent,
  monthLabel,
} from "@/app/lib/allowance";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { UsageChart } from "./UsageChart";

const DAY_SECONDS = 24 * 60 * 60;

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
    help: "Hours your sandboxes spent running, idle time until they stop included, at the default 1 vCPU / 2 GB size. A bigger sandbox, a resume or a kept snapshot uses hours faster. Sandboxes on your own provider account are free.",
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
    help: "What the latest daily snapshot found stored in your workspaces, chat attachments, skills and bundles. A size, not a monthly total.",
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

interface AllowanceRow {
  key: keyof BudgetUsage["totals"];
  label: string;
  unit: AmountUnit;
  share: keyof BudgetUsage["shares"] | null;
  color: string;
  help?: string;
}

/**
 * The Usage tab's Allowance: the org's month per resource against its cap,
 * with a month picker. Clicking a row charts that resource per day under the
 * table. Holds the last month while another loads, so the table and chart
 * ease to it instead of dropping to a skeleton first.
 */
export function AllowanceUsage(): React.JSX.Element {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const usage = useQuery(api.account.budget.getForActiveOrg, { month: month });
  const [held, setHeld] = useState<BudgetUsage | null | undefined>(undefined);
  if (usage !== undefined && usage !== held) setHeld(usage);
  const budget = usage === undefined ? held : usage;

  // The current month leads `months` and is Billing's own query: leave
  // `month` unset to share it.
  function handleMonthChange(value: string): void {
    setMonth(value === budget?.months[0] ? undefined : value);
  }

  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-foreground">Allowance</h2>
          {budget && (
            <span className="text-xs text-muted-foreground">
              {resetLabel(budget)}
            </span>
          )}
        </div>
        {budget && (
          <Select
            items={budget.months.map((option) => ({
              label: monthLabel(option),
              value: option,
            }))}
            value={month ?? budget.month}
            onValueChange={(value) => {
              if (value) handleMonthChange(value);
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
      {budget === undefined ? (
        <Skeleton className="h-96 rounded-lg" />
      ) : budget === null ? (
        <p className="text-sm text-muted-foreground">
          No account in this organization yet.
        </p>
      ) : (
        <AllowanceTable budget={budget} />
      )}
    </section>
  );
}

// The resources against their caps, and the picked one's daily chart.
function AllowanceTable({
  budget,
}: {
  budget: BudgetUsage;
}): React.JSX.Element {
  const [picked, setPicked] = useState<AllowanceRow>(ROWS[0]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Resource</TableHead>
            <TableHead className="text-right">Used</TableHead>
            <TableHead className="text-right">Limit</TableHead>
            <TableHead className="w-2/5" />
            <TableHead className="w-16" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {ROWS.map((row) => (
            <AllowanceTableRow
              key={row.key}
              budget={budget}
              row={row}
              active={row.key === picked.key}
              onPick={() => setPicked(row)}
            />
          ))}
        </TableBody>
      </Table>
      <Separator />
      <DailyChart budget={budget} row={picked} />
    </div>
  );
}

// One resource: used, its cap, and how close it is. Ingress reads Free.
function AllowanceTableRow({
  budget,
  row,
  active,
  onPick,
}: {
  budget: BudgetUsage;
  row: AllowanceRow;
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
      <TableCell className="text-right">
        <span className="tabular-nums">
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
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full w-(--bar-width) rounded-full bg-foreground"
              style={{ "--bar-width": `${Math.min(share, 100)}%` }}
            />
          </div>
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

// The picked resource per day of the month, in one unit from the tallest day.
function DailyChart({
  budget,
  row,
}: {
  budget: BudgetUsage;
  row: AllowanceRow;
}): React.JSX.Element {
  // UsageChart eases to each new rows array, so only rebuild on real change.
  const daily = useMemo(() => dailySeries(budget, row.key), [budget, row.key]);
  const axisMax = Math.max(0, ...daily.rows.map(([value]) => value ?? 0));
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
        series={[{ key: row.key, label: row.label, color: row.color }]}
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

// "Resets Oct 1" for the current month, nothing for a past one or no limits.
function resetLabel(budget: BudgetUsage): string {
  if (!budget.enforced) return "No limits";

  return budget.month === budget.months[0]
    ? `Resets ${billingReset(budget.month)}`
    : "";
}
