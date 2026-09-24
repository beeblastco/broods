"use client";

import { Section } from "@/app/components/Section";
import {
  StackedBarChart,
  type ChartBin,
} from "@/app/components/StackedBarChart";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Skeleton } from "@/app/components/ui/skeleton";
import { toErrorMessage } from "@/app/lib/errors";
import type { PlanTier } from "@/app/lib/pricing";
import { DEFAULT_PLAN, isMaxPlan, PLAN_CONFIGS } from "@/app/lib/pricing";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowUpRight, CreditCard } from "lucide-react";
import { useState } from "react";

const DAY_SECONDS = 24 * 60 * 60;

// Rows of the usage table, grouped like Convex's usage page. `share` is the
// budget group the row counts toward; ingress is free, so it has none.
const USAGE_GROUPS: Array<{ label: string; rows: UsageRow[] }> = [
  {
    label: "Compute",
    rows: [
      {
        key: "sandboxHours",
        label: "Sandbox time",
        unit: "hours",
        share: "sandboxes",
        color: "var(--color-usage-agent-sandbox)",
      },
      {
        key: "hostedMcpCalls",
        label: "Hosted MCP calls",
        unit: "count",
        share: "hostedMcp",
        color: "var(--color-usage-mcp-sandbox)",
      },
    ],
  },
  {
    label: "Storage",
    rows: [
      {
        key: "storageGb",
        label: "Workspaces and files",
        unit: "gb",
        share: "storage",
        color: "var(--color-usage-storage)",
      },
    ],
  },
  {
    label: "Network",
    rows: [
      {
        key: "egressGb",
        label: "Egress",
        unit: "gb",
        share: "network",
        color: "var(--color-usage-egress)",
      },
      {
        key: "ingressGb",
        label: "Ingress",
        unit: "gb",
        share: null,
        color: "var(--color-usage-ingress)",
      },
    ],
  },
];

const USAGE_ROWS = USAGE_GROUPS.flatMap((group) => group.rows);

// Stripe states where a payment is owed and the portal can fix it.
const PAYMENT_DUE_STATUSES = new Set(["past_due", "unpaid", "incomplete"]);

type BudgetUsage = NonNullable<
  FunctionReturnType<typeof api.account.budget.getForActiveOrg>
>;
type UsageAmounts = BudgetUsage["totals"];

interface UsageRow {
  key: keyof UsageAmounts;
  label: string;
  unit: "hours" | "count" | "gb";
  share: keyof BudgetUsage["categories"] | null;
  color: string;
}

interface Notice {
  tone: "warning" | "destructive" | "info";
  text: string;
  action?: "upgrade" | "portal";
  actionLabel?: string;
}

interface Props {
  projectId: Id<"projects">;
}

/**
 * Billing tab: the plan with its one action, a single notice when something
 * needs attention, then a month's usage in real units with each resource's
 * share of the allowance and a daily chart. Euro budgets never reach the
 * browser; the backend sends amounts and percentages.
 */
export function BillingPanel({ projectId }: Props): React.JSX.Element {
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [month, setMonth] = useState<string | undefined>(undefined);

  const currentUser = useQuery(api.user.getCurrent);
  const billingInfo = useQuery(api.stripe.getBillingInfo);
  // The plan and its notice always read this month; only the usage section
  // follows the picker, so switching months never blanks the plan.
  const budget = useQuery(api.account.budget.getForActiveOrg, {});
  const shownMonth = useQuery(api.account.budget.getForActiveOrg, {
    month: month,
  });
  const createCheckoutSession = useAction(api.stripe.createCheckoutSession);
  const createPortalSession = useAction(api.stripe.createPortalSession);

  const plan: PlanTier = budget?.plan ?? currentUser?.plan ?? DEFAULT_PLAN;
  const status: string | undefined = billingInfo?.status;
  // A live subscription in any state (even past_due) goes through the portal;
  // checkout refuses it. `undefined` is still loading, so no Upgrade yet.
  // Self-hosted installs have no plans to buy.
  const hasSubscription = billingInfo != null;
  const canUpgrade =
    billingInfo === null && !isMaxPlan(plan) && budget?.enforced === true;
  const notice = pickNotice(
    budget,
    status,
    billingInfo?.currentPeriodEnd,
    canUpgrade,
  );

  async function handleUpgrade(): Promise<void> {
    setCheckoutLoading(true);
    setActionError(null);
    try {
      const origin = window.location.origin;
      const returnPath = `/${projectId}/dashboard?tab=billing`;
      const { url } = await createCheckoutSession({
        successUrl: `${origin}${returnPath}&success=true`,
        cancelUrl: `${origin}${returnPath}`,
      });
      window.location.href = url;
    } catch (err) {
      setActionError(toErrorMessage(err));
      setCheckoutLoading(false);
    }
  }

  async function handlePortal(): Promise<void> {
    setPortalLoading(true);
    setActionError(null);
    try {
      const origin = window.location.origin;
      const { url } = await createPortalSession({
        returnUrl: `${origin}/${projectId}/dashboard?tab=billing`,
      });
      window.location.href = url;
    } catch (err) {
      setActionError(toErrorMessage(err));
      setPortalLoading(false);
    }
  }

  return (
    <div className="grid gap-8">
      <Section title="Plan">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
          <PlanSummary
            budget={budget}
            plan={plan}
            status={status}
            periodEnd={billingInfo?.currentPeriodEnd}
            cancelAtPeriodEnd={billingInfo?.cancelAtPeriodEnd === true}
          />
          {hasSubscription && (
            <Button
              size="sm"
              variant="outline"
              className="cursor-pointer"
              onClick={handlePortal}
              disabled={portalLoading}
            >
              <CreditCard className="size-3.5" />
              {portalLoading ? "Loading…" : "Manage subscription"}
            </Button>
          )}
          {canUpgrade && (
            <Button
              size="sm"
              className="cursor-pointer"
              onClick={handleUpgrade}
              disabled={checkoutLoading}
            >
              <ArrowUpRight className="size-3.5" />
              {checkoutLoading ? "Loading…" : "Upgrade to Pro"}
            </Button>
          )}
        </div>
        {actionError && (
          <p className="text-sm text-destructive">{actionError}</p>
        )}
      </Section>

      {notice && (
        <NoticeBar
          notice={notice}
          disabled={checkoutLoading || portalLoading}
          onAction={notice.action === "upgrade" ? handleUpgrade : handlePortal}
        />
      )}

      <UsageSummary budget={shownMonth} onMonthChange={setMonth} />
      <DailyUsage budget={shownMonth} />
    </div>
  );
}

// One resource's usage per day of the month, picked with the toggle above it.
function DailyUsage({
  budget,
}: {
  budget: BudgetUsage | null | undefined;
}): React.JSX.Element | null {
  const [row, setRow] = useState<UsageRow>(USAGE_ROWS[0]);
  if (!budget) return null;

  return (
    <Section title="Daily usage">
      <div className="flex w-fit flex-wrap items-center gap-1 rounded-md border border-border bg-card p-1">
        {USAGE_ROWS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setRow(option)}
            className={cn(
              "cursor-pointer rounded px-2.5 py-1 text-xs transition-colors",
              row.key === option.key
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-border bg-card p-3">
        {budget.days.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No daily usage recorded for this month.
          </p>
        ) : (
          <StackedBarChart
            bins={dailyBins(budget)}
            binSeconds={DAY_SECONDS}
            series={[{ key: row.key, label: row.label, color: row.color }]}
            formatAxis={(value) => formatAmount(value, row.unit)}
            formatValue={(value) => formatAmount(value, row.unit)}
          />
        )}
      </div>
    </Section>
  );
}

function NoticeBar({
  notice,
  disabled,
  onAction,
}: {
  notice: Notice;
  disabled: boolean;
  onAction: () => Promise<void>;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 rounded-lg border px-4 py-2.5",
        notice.tone === "warning" && "border-warning/40 bg-warning/5",
        notice.tone === "destructive" &&
          "border-destructive/40 bg-destructive/5",
        notice.tone === "info" && "border-info/40 bg-info/5",
      )}
    >
      <p className="text-sm text-foreground">{notice.text}</p>
      {notice.action && (
        <Button
          size="sm"
          className="cursor-pointer"
          onClick={onAction}
          disabled={disabled}
        >
          {notice.actionLabel}
        </Button>
      )}
    </div>
  );
}

function PlanBadge({
  selfHosted,
  status,
}: {
  selfHosted: boolean;
  status: string | undefined;
}): React.JSX.Element {
  if (selfHosted) return <Badge variant="secondary">Unlimited</Badge>;
  if (status === "trialing") return <Badge variant="info">Trial</Badge>;
  if (status === "active") return <Badge variant="success">Active</Badge>;
  if (status && PAYMENT_DUE_STATUSES.has(status)) {
    return <Badge variant="destructive">Payment due</Badge>;
  }

  return <Badge variant="secondary">Free</Badge>;
}

// Plan name, status badge, and when it renews or resets.
function PlanSummary({
  budget,
  plan,
  status,
  periodEnd,
  cancelAtPeriodEnd,
}: {
  budget: BudgetUsage | null | undefined;
  plan: PlanTier;
  status: string | undefined;
  periodEnd: number | undefined;
  cancelAtPeriodEnd: boolean;
}): React.JSX.Element {
  const selfHosted = budget?.enforced === false;

  return (
    <div className="grid gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">
          {selfHosted ? "Self-hosted" : PLAN_CONFIGS[plan].label}
        </span>
        <PlanBadge selfHosted={selfHosted} status={status} />
      </div>
      <p className="text-xs text-muted-foreground">
        {planDetail(budget, selfHosted, status, periodEnd, cancelAtPeriodEnd)}
      </p>
    </div>
  );
}

// The month's allowance used, a month picker, and one row per resource.
function UsageSummary({
  budget,
  onMonthChange,
}: {
  budget: BudgetUsage | null | undefined;
  onMonthChange: (month: string) => void;
}): React.JSX.Element {
  return (
    <Section title="Usage">
      {budget === undefined ? (
        <Skeleton className="h-72 rounded-lg" />
      ) : budget === null ? (
        <p className="text-sm text-muted-foreground">
          No account in this organization yet.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4">
            <span
              className={cn(
                "text-sm tabular-nums",
                budget.level === "warning" && "text-warning",
                budget.level === "exhausted" && "text-destructive",
                budget.level === "ok" && "text-foreground",
              )}
            >
              {budget.usedPercent === null
                ? "No limit"
                : `${formatPercent(budget.usedPercent)} of monthly allowance`}
            </span>
            <Select
              items={budget.months.map((month) => ({
                label: monthLabel(month),
                value: month,
              }))}
              value={budget.month}
              onValueChange={(value) => {
                if (value) onMonthChange(value);
              }}
            >
              <SelectTrigger size="sm" className="cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {budget.months.map((month) => (
                  <SelectItem key={month} value={month}>
                    {monthLabel(month)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {budget.usedPercent !== null && (
            <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full w-(--bar-width) bg-foreground"
                style={{
                  "--bar-width": `${Math.min(budget.usedPercent, 100)}%`,
                }}
              />
            </div>
          )}
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="grid grid-cols-6 items-center gap-4 border-b border-border px-4 py-2 text-xs text-muted-foreground">
              <span className="col-span-2">Resource</span>
              <span className="text-right">Used</span>
              <span className="col-span-2">
                {budget.enforced ? "Share of allowance" : "Share of usage"}
              </span>
            </div>
            {USAGE_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="border-b border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
                  {group.label}
                </div>
                {group.rows.map((row) => (
                  <UsageTableRow key={row.key} budget={budget} row={row} />
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

function UsageTableRow({
  budget,
  row,
}: {
  budget: BudgetUsage;
  row: UsageRow;
}): React.JSX.Element {
  const share = row.share === null ? null : budget.categories[row.share];

  return (
    <div className="grid grid-cols-6 items-center gap-4 border-b border-border px-4 py-2.5 last:border-b-0">
      <span className="col-span-2 text-sm text-foreground">{row.label}</span>
      <span className="text-right text-sm tabular-nums text-foreground">
        {formatAmount(budget.totals[row.key], row.unit)}
      </span>
      {share === null ? (
        <span className="col-span-3 text-xs text-muted-foreground">Free</span>
      ) : (
        <>
          <div className="col-span-2 flex h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full w-(--bar-width) bg-foreground"
              style={{ "--bar-width": `${Math.min(share, 100)}%` }}
            />
          </div>
          <span className="text-right text-sm tabular-nums text-muted-foreground">
            {formatPercent(share)}
          </span>
        </>
      )}
    </div>
  );
}

// Calendar month "YYYY-MM" as the UTC day it resets on.
function billingReset(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);

  return formatDay(Date.UTC(year, monthNumber, 1));
}

// Every day of the month as a chart bin, zero where nothing was used.
function dailyBins(budget: BudgetUsage): Array<ChartBin<UsageRow["key"]>> {
  const [year, monthNumber] = budget.month.split("-").map(Number);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const byDay = new Map(budget.days.map((day) => [day.day, day]));

  return Array.from({ length: dayCount }, (_, index) => {
    const bucketStart = Date.UTC(year, monthNumber - 1, index + 1);
    const used = byDay.get(new Date(bucketStart).toISOString().slice(0, 10));

    return {
      bucketStart: bucketStart,
      sandboxHours: used?.sandboxHours ?? 0,
      hostedMcpCalls: used?.hostedMcpCalls ?? 0,
      storageGb: used?.storageGb ?? 0,
      egressGb: used?.egressGb ?? 0,
      ingressGb: used?.ingressGb ?? 0,
    };
  });
}

// An amount in its unit, scaling GB down to MB or KB so small numbers stay
// readable. Null is a storage size no snapshot has measured yet.
function formatAmount(value: number | null, unit: UsageRow["unit"]): string {
  if (value === null) return "–";
  if (unit === "count") return Math.round(value).toLocaleString();
  if (unit === "hours") return `${formatDecimal(value)} h`;
  if (value === 0 || value >= 1) return `${formatDecimal(value)} GB`;
  if (value >= 0.001) return `${formatDecimal(value * 1000)} MB`;

  return `${formatDecimal(value * 1_000_000)} KB`;
}

function formatDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatDecimal(value: number): string {
  return value.toLocaleString([], {
    maximumFractionDigits: value < 10 ? 2 : 1,
  });
}

function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";

  return `${Math.round(percent)}%`;
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);

  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleDateString([], {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// The one notice worth showing, most urgent first.
function pickNotice(
  budget: BudgetUsage | null | undefined,
  status: string | undefined,
  periodEnd: number | undefined,
  canUpgrade: boolean,
): Notice | null {
  if (!budget) return null;
  const reset = billingReset(budget.month);
  if (status && PAYMENT_DUE_STATUSES.has(status)) {
    return {
      tone: "destructive",
      text: "Payment failed. Update your card to keep Pro.",
      action: "portal",
      actionLabel: "Update card",
    };
  }
  if (budget.level === "exhausted") {
    return {
      tone: "destructive",
      text: canUpgrade
        ? `Allowance used up. Runs are stopped and each channel got a notice. Upgrade to resume, or wait for ${reset}.`
        : `Allowance used up. Runs are stopped and each channel got a notice. They resume on ${reset}.`,
      ...(canUpgrade ? { action: "upgrade", actionLabel: "Upgrade" } : {}),
    };
  }
  if (budget.level === "warning") {
    return {
      tone: "warning",
      text: `${formatPercent(budget.usedPercent ?? 0)} of this month's allowance used. Runs stop at 100% until ${reset}.`,
      ...(canUpgrade ? { action: "upgrade", actionLabel: "Upgrade" } : {}),
    };
  }
  if (status === "trialing" && periodEnd) {
    return {
      tone: "info",
      text: `Pro trial ends ${formatDay(periodEnd * 1000)}. Keep a card on file to stay on Pro.`,
      action: "portal",
      actionLabel: "Add card",
    };
  }

  return null;
}

function planDetail(
  budget: BudgetUsage | null | undefined,
  selfHosted: boolean,
  status: string | undefined,
  periodEnd: number | undefined,
  cancelAtPeriodEnd: boolean,
): string {
  if (selfHosted) return "Your own install. Every feature, no limits.";
  if (periodEnd) {
    const day = formatDay(periodEnd * 1000);
    if (status === "trialing") return `Trial ends ${day}`;

    return `${cancelAtPeriodEnd ? "Cancels on" : "Renews on"} ${day}`;
  }

  return budget ? `Resets ${billingReset(budget.months[0])}` : "";
}
