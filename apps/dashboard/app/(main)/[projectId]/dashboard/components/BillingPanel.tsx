"use client";

import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  billingReset,
  type BudgetUsage,
  formatDay,
  formatPercent,
} from "@/app/lib/allowance";
import { toErrorMessage } from "@/app/lib/errors";
import type { PlanTier } from "@/app/lib/pricing";
import { DEFAULT_PLAN, isMaxPlan, PLAN_CONFIGS } from "@/app/lib/pricing";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { ArrowRight, ArrowUpRight, CreditCard } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

// Stripe states where a payment is owed and the portal can fix it.
const PAYMENT_DUE_STATUSES = new Set(["past_due", "unpaid", "incomplete"]);

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
 * Billing tab: the plan with its one action and one bar for the closest cap,
 * then a single notice when something needs attention. The per-resource
 * allowance lives on the Usage tab, which the bar links to.
 */
export function BillingPanel({ projectId }: Props): React.JSX.Element {
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const currentUser = useQuery(api.user.getCurrent);
  const billingInfo = useQuery(api.stripe.getBillingInfo);
  // The plan and its notice always read this month; only MonthUsage follows
  // the picker, so switching months never blanks the plan.
  const budget = useQuery(api.account.budget.getForActiveOrg, {});
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
        <div className="grid gap-4 rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex items-center justify-between gap-4">
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
          <AllowanceBar budget={budget} projectId={projectId} />
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
    </div>
  );
}

// The closest cap's share as one bar, linking to the full allowance. Nothing
// while it loads or on an install with no caps.
function AllowanceBar({
  budget,
  projectId,
}: {
  budget: BudgetUsage | null | undefined;
  projectId: Id<"projects">;
}): React.JSX.Element | null {
  const searchParams = useSearchParams();
  if (budget?.usedPercent == null) return null;
  const used = budget.usedPercent;

  return (
    <div className="flex items-center gap-3">
      <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full w-(--bar-width) rounded-full",
            budget.level === "ok" && "bg-foreground",
            budget.level === "warning" && "bg-warning",
            budget.level === "exhausted" && "bg-destructive",
          )}
          style={{ "--bar-width": `${Math.min(used, 100)}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatPercent(used)} used
      </span>
      <Button
        nativeButton={false}
        render={<Link href={usageHref(projectId, searchParams)} />}
        size="xs"
        variant="ghost"
        className="cursor-pointer"
      >
        View usage
        <ArrowRight data-icon="inline-end" />
      </Button>
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
  const detail = planDetail(
    budget,
    selfHosted,
    status,
    periodEnd,
    cancelAtPeriodEnd,
  );

  return (
    <div className="grid gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">
          {selfHosted ? "Self-hosted" : PLAN_CONFIGS[plan].label}
        </span>
        <PlanBadge selfHosted={selfHosted} status={status} />
      </div>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
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
): string | null {
  if (selfHosted) return "Your own install. Every feature, no limits.";
  if (periodEnd) {
    const day = formatDay(periodEnd * 1000);
    if (status === "trialing") return `Trial ends ${day}`;

    return `${cancelAtPeriodEnd ? "Cancels on" : "Renews on"} ${day}`;
  }

  return budget ? `Resets ${billingReset(budget.month)}` : null;
}

// The Usage tab, keeping the other params (the stage) the page carries.
function usageHref(
  projectId: Id<"projects">,
  searchParams: URLSearchParams,
): string {
  const next = new URLSearchParams(searchParams);
  next.set("tab", "usage");

  return `/${projectId}/dashboard?${next.toString()}`;
}
