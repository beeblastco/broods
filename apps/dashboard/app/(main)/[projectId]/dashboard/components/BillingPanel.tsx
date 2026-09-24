"use client";

import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
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

// Rows of the usage table, in the groups the backend splits the meter into.
const USAGE_ROWS: Array<{
  key: keyof BudgetUsage["categories"];
  label: string;
  description: string;
  barClass: string;
}> = [
  {
    key: "sandboxes",
    label: "Sandboxes",
    description: "Agent sandbox running time",
    barClass: "bg-usage-agent-sandbox",
  },
  {
    key: "hostedMcp",
    label: "Hosted MCP",
    description: "Uploaded MCP server calls",
    barClass: "bg-usage-mcp-sandbox",
  },
  {
    key: "storage",
    label: "Storage",
    description: "Workspaces, skills and bundles",
    barClass: "bg-usage-storage",
  },
  {
    key: "egress",
    label: "Egress",
    description: "Data sent out of Broods",
    barClass: "bg-usage-egress",
  },
];

// Stripe states where a payment is owed and the portal can fix it.
const PAYMENT_DUE_STATUSES = new Set(["past_due", "unpaid", "incomplete"]);

type BudgetUsage = NonNullable<
  FunctionReturnType<typeof api.account.budget.getForActiveOrg>
>;

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
 * needs attention, and this month's usage as shares of the plan's allowance.
 * Euro budgets never reach the browser; the backend sends percentages.
 */
export function BillingPanel({ projectId }: Props): React.JSX.Element {
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const currentUser = useQuery(api.user.getCurrent);
  const billingInfo = useQuery(api.stripe.getBillingInfo);
  const budget = useQuery(api.account.budget.getForActiveOrg);
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

      <UsageTable budget={budget} />
    </div>
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

// Plan name, status badge, and when it renews or how fast it may run.
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

// This month's usage, one row per group and a total, like Convex's usage page.
function UsageTable({
  budget,
}: {
  budget: BudgetUsage | null | undefined;
}): React.JSX.Element {
  const period = budget ? billingPeriod(budget.month) : null;

  return (
    <Section
      title="Usage"
      description={
        period ? `${period.range} · resets ${period.reset}` : "This month"
      }
    >
      {budget === undefined ? (
        <Skeleton className="h-64 rounded-lg" />
      ) : budget === null ? (
        <p className="text-sm text-muted-foreground">
          No account in this organization yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-5 items-center gap-4 border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <span className="col-span-2">Resource</span>
            <span className="col-span-2">
              {budget.enforced
                ? "Share of monthly allowance"
                : "Share of usage"}
            </span>
            <span className="text-right">Used</span>
          </div>
          {USAGE_ROWS.map((row) => (
            <div
              key={row.key}
              className="grid grid-cols-5 items-center gap-4 border-b border-border px-4 py-2.5"
            >
              <div className="col-span-2 grid">
                <span className="text-sm text-foreground">{row.label}</span>
                <span className="text-xs text-muted-foreground">
                  {row.description}
                </span>
              </div>
              <div className="col-span-2 flex h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full w-(--bar-width)", row.barClass)}
                  style={{
                    "--bar-width": `${Math.min(budget.categories[row.key], 100)}%`,
                  }}
                />
              </div>
              <span className="text-right text-sm tabular-nums text-foreground">
                {formatPercent(budget.categories[row.key])}
              </span>
            </div>
          ))}
          <div className="grid grid-cols-5 items-center gap-4 bg-muted/40 px-4 py-2.5">
            <span className="col-span-2 text-sm font-medium text-foreground">
              Total
            </span>
            <div className="col-span-2 flex h-1.5 gap-px overflow-hidden rounded-full bg-muted">
              {USAGE_ROWS.map((row) => (
                <div
                  key={row.key}
                  className={cn("h-full w-(--bar-width)", row.barClass)}
                  style={{
                    "--bar-width": `${budget.categories[row.key]}%`,
                  }}
                />
              ))}
            </div>
            <span
              className={cn(
                "text-right text-sm font-medium tabular-nums",
                budget.level === "warning" && "text-warning",
                budget.level === "exhausted" && "text-destructive",
                budget.level === "ok" && "text-foreground",
              )}
            >
              {budget.usedPercent === null
                ? "No limit"
                : formatPercent(Math.min(budget.usedPercent, 100))}
            </span>
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Model tokens run on your own provider keys and never count.
      </p>
    </Section>
  );
}

// Calendar month "YYYY-MM" as the UTC range it covers and the day it resets.
function billingPeriod(month: string): { range: string; reset: string } {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = Date.UTC(year, monthNumber - 1, 1);
  const end = Date.UTC(year, monthNumber, 0);
  const reset = Date.UTC(year, monthNumber, 1);

  return {
    range: `${formatDay(start)} to ${formatDay(end)}, ${year}`,
    reset: formatDay(reset),
  };
}

function formatDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";

  return `${Math.round(percent)}%`;
}

// The one notice worth showing, most urgent first.
function pickNotice(
  budget: BudgetUsage | null | undefined,
  status: string | undefined,
  periodEnd: number | undefined,
  canUpgrade: boolean,
): Notice | null {
  if (!budget) return null;
  const reset = billingPeriod(budget.month).reset;
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
  const runs = budget
    ? `${budget.runsPerMinute.toLocaleString()} runs / min`
    : null;
  const renewal = !periodEnd
    ? "Monthly compute allowance"
    : status === "trialing"
      ? `Trial ends ${formatDay(periodEnd * 1000)}`
      : `${cancelAtPeriodEnd ? "Cancels on" : "Renews on"} ${formatDay(periodEnd * 1000)}`;

  return runs ? `${renewal} · ${runs}` : renewal;
}
