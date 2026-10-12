"use client";

import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { type OrgSeats, useOrgSeats } from "@/app/hooks/useOrgSeats";
import { useSubmit } from "@/app/hooks/useSubmit";
import {
  billingReset,
  type BudgetUsage,
  formatDay,
  formatPercent,
} from "@/app/lib/allowance";
import { toErrorMessage } from "@/app/lib/errors";
import type { PlanTier } from "@/app/lib/pricing";
import {
  DEFAULT_PLAN,
  isMaxPlan,
  PLAN_CONFIGS,
  SEAT_PRICE_EUR,
  seatsAndPrice,
} from "@/app/lib/pricing";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { clientErrorData } from "@broods/convex/model/clientError";
import { isPaid } from "@broods/convex/model/orgBilling";
import {
  BUDGET_WARNING_RATIO,
  capsReached,
} from "@broods/convex/model/planLimits";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { ArrowRight, ArrowUpRight, CreditCard, Plus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

// Stripe states where a payment is owed and the portal can fix it.
const PAYMENT_DUE_STATUSES = new Set(["past_due", "unpaid", "incomplete"]);

// Past this many seats the row of marks stops growing; the words carry the count.
const MAX_SEAT_MARKS = 20;

interface Notice {
  tone: "warning" | "destructive" | "info";
  text: string;
  action?: "upgrade" | "portal";
  actionLabel?: string;
}

interface Props {
  projectId: Id<"projects">;
}

// Checkout returns with success=true before Stripe's webhook updates the plan.
const ACTIVATING_NOTICE: Notice = {
  tone: "info",
  text: "Payment received. Activating Pro…",
};

/**
 * Billing tab, for the active org: the plan with its seats and the owner's
 * actions, one bar for the closest cap, then a single notice when something
 * needs attention. Every member sees the plan; only the owner pays, so only
 * the owner gets Upgrade, Add seat and the portal. The per-resource allowance
 * lives on the Usage tab, which the bar links to.
 */
export function BillingPanel({ projectId }: Props): React.JSX.Element {
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const searchParams = useSearchParams();

  const seats = useOrgSeats();
  // The plan and its notice always read this month; only MonthUsage follows
  // the picker, so switching months never blanks the plan.
  const budget = useQuery(api.account.budget.getForActiveOrg, {});
  const createCheckoutSession = useAction(api.stripe.createCheckoutSession);
  const createPortalSession = useAction(api.stripe.createPortalSession);

  const billingInfo = seats?.billing;
  const plan: PlanTier = budget?.plan ?? DEFAULT_PLAN;
  const isOwner = seats?.isOwner === true;
  // A live subscription in any state (even past_due) goes through the portal;
  // checkout refuses it. `undefined` is still loading, so no Upgrade yet.
  // Self-hosted installs have no plans to buy. Every member sees Upgrade on
  // a free org; only the owner can press it.
  const showUpgrade =
    billingInfo === null && !isMaxPlan(plan) && budget?.enforced === true;
  const canUpgrade = showUpgrade && isOwner;
  // What a member of a free org hears instead of a checkout.
  const ownerOnly =
    showUpgrade && seats && !isOwner
      ? `Only ${seats.ownerName}, the owner, can upgrade ${seats.org.name}. You are not charged.`
      : null;
  const notice = pickNotice(
    budget,
    billingInfo?.status,
    billingInfo?.currentPeriodEnd,
    canUpgrade,
    ownerOnly,
    plan,
    searchParams.get("success") === "true",
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
      const forbidden = clientErrorData(err)?.code === "forbidden";
      setActionError((forbidden && ownerOnly) || toErrorMessage(err));
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
      <Section title={seats ? `Plan · ${seats.org.name}` : "Plan"}>
        <div className="grid gap-4 rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <PlanSummary budget={budget} plan={plan} seats={seats} />
            <PlanActions
              seats={seats}
              showUpgrade={showUpgrade}
              checkoutLoading={checkoutLoading}
              portalLoading={portalLoading}
              onUpgrade={handleUpgrade}
              onPortal={handlePortal}
            />
          </div>
          <AllowanceBar budget={budget} projectId={projectId} />
          <SeatsRow seats={seats} />
        </div>
        {actionError && (
          <p className="text-sm text-destructive">{actionError}</p>
        )}
      </Section>

      {notice && (
        <NoticeBar
          notice={notice}
          // A member reads the notice; the portal is the owner's.
          actionable={notice.action === "upgrade" ? canUpgrade : isOwner}
          disabled={checkoutLoading || portalLoading}
          onAction={notice.action === "upgrade" ? handleUpgrade : handlePortal}
        />
      )}
    </div>
  );
}

/**
 * The owner's actions on the plan: Add seat and the portal once the org has a
 * subscription, Upgrade before. A member sees Upgrade greyed out, since only
 * the owner pays.
 */
function PlanActions({
  seats,
  showUpgrade,
  checkoutLoading,
  portalLoading,
  onUpgrade,
  onPortal,
}: {
  seats: OrgSeats | undefined;
  showUpgrade: boolean;
  checkoutLoading: boolean;
  portalLoading: boolean;
  onUpgrade: () => Promise<void>;
  onPortal: () => Promise<void>;
}): React.JSX.Element {
  const owner = seats?.isOwner === true;
  const billing = seats?.billing;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {owner && billing && isPaid(billing.status) && (
        <AddSeatButton org={seats.org} />
      )}
      {owner && billing && (
        <Button
          size="sm"
          variant="outline"
          className="cursor-pointer"
          onClick={onPortal}
          disabled={portalLoading}
        >
          <CreditCard className="size-3.5" />
          {portalLoading ? "Loading…" : "Manage subscription"}
        </Button>
      )}
      {showUpgrade && (
        <Button
          size="sm"
          className="cursor-pointer"
          onClick={onUpgrade}
          disabled={checkoutLoading || !owner}
        >
          <ArrowUpRight className="size-3.5" />
          {checkoutLoading ? "Loading…" : upgradeLabel(seats)}
        </Button>
      )}
    </div>
  );
}

/**
 * The owner's Add seat, behind one confirm: Stripe charges the prorated seat
 * at once, and adds it only when that payment goes through.
 */
function AddSeatButton({ org }: { org: OrgSeats["org"] }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const { pending, error, run } = useSubmit();
  const addSeat = useAction(api.stripe.addSeat);

  async function confirm(): Promise<void> {
    if (await run(() => addSeat({ orgId: org._id }))) setConfirming(false);
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="cursor-pointer"
        onClick={() => setConfirming(true)}
      >
        <Plus className="size-3.5" />
        Add seat
      </Button>
      {confirming && (
        <ConfirmDialog
          title={`Add a seat to ${org.name}`}
          description={`Add 1 seat for €${SEAT_PRICE_EUR}/month. You are charged now for the rest of this period.`}
          verb="Add seat"
          variant="default"
          pending={pending}
          error={error}
          onConfirm={() => void confirm()}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** Upgrade with what it pays for: one seat per member. A member only reads it. */
function upgradeLabel(seats: OrgSeats | undefined): string {
  return seats?.isOwner
    ? `Upgrade to Pro · ${seatsAndPrice(Math.max(1, seats.members))}`
    : "Upgrade to Pro";
}

/**
 * The owner's seats: one mark per seat or member, filled where a member sits.
 * A free org whose members were kept from before seats counted says what
 * Upgrade pays for. Nothing for a member, or on an install without seats.
 */
function SeatsRow({
  seats,
}: {
  seats: OrgSeats | undefined;
}): React.JSX.Element | null {
  if (!seats?.enforced || !seats.isOwner) return null;
  const marks = Math.min(Math.max(seats.members, seats.seats), MAX_SEAT_MARKS);

  return (
    <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Seats</span>
        {" · "}
        {seats.billing === null && seats.members > seats.seats
          ? `${seats.members} members on the free plan's ${seats.seats} seat. Upgrading pays for all ${seats.members}; no new invites until then.`
          : `${seats.members} of ${seats.seats} used`}
      </p>
      <div className="flex shrink-0 gap-1" aria-hidden>
        {Array.from({ length: marks }, (_, index) => (
          <span
            key={index}
            className={cn(
              "size-2.5 rounded-xs",
              index < seats.members ? "bg-foreground" : "bg-muted",
            )}
          />
        ))}
      </div>
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
  actionable,
  disabled,
  onAction,
}: {
  notice: Notice;
  actionable: boolean;
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
      {notice.action && actionable && (
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

// Plan name, status badge, its seats, and when it renews or resets.
function PlanSummary({
  budget,
  plan,
  seats,
}: {
  budget: BudgetUsage | null | undefined;
  plan: PlanTier;
  seats: OrgSeats | undefined;
}): React.JSX.Element {
  const selfHosted = budget?.enforced === false;
  const detail = planDetail(budget, selfHosted, seats);

  return (
    <div className="grid gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">
          {selfHosted ? "Self-hosted" : PLAN_CONFIGS[plan].label}
        </span>
        <PlanBadge selfHosted={selfHosted} status={seats?.billing?.status} />
      </div>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

// The one notice worth showing, most urgent first. `checkoutReturned` is the
// success=true Stripe adds to the checkout return URL; a payment due outranks
// it, since the URL keeps that flag after the subscription later fails.
// `ownerOnly` tells a member of a free org who can upgrade it.
function pickNotice(
  budget: BudgetUsage | null | undefined,
  status: string | undefined,
  periodEnd: number | undefined,
  canUpgrade: boolean,
  ownerOnly: string | null,
  plan: PlanTier,
  checkoutReturned: boolean,
): Notice | null {
  if (status && PAYMENT_DUE_STATUSES.has(status)) {
    return {
      tone: "destructive",
      text: "Payment failed. Update your card to keep Pro.",
      action: "portal",
      actionLabel: "Update card",
    };
  }
  if (checkoutReturned && plan === DEFAULT_PLAN) return ACTIVATING_NOTICE;
  if (!budget) return null;
  const reset = billingReset(budget.month);
  // Storage is a size: a new month does not free it, deleting files does.
  const storage = capsReached(
    budget.shares,
    budget.level === "exhausted" ? 100 : BUDGET_WARNING_RATIO * 100,
  );
  if (budget.level !== "ok" && storage.storage) {
    return storageNotice(
      budget,
      canUpgrade,
      ownerOnly,
      storage.monthly ? reset : null,
    );
  }
  if (budget.level === "exhausted") {
    return {
      tone: "destructive",
      text: canUpgrade
        ? `Allowance used up. Runs are stopped and each channel got a notice. Upgrade to resume, or wait for ${reset}.`
        : `Allowance used up. Runs are stopped and each channel got a notice. They resume on ${reset}.${ownerOnly ? ` ${ownerOnly}` : ""}`,
      ...(canUpgrade ? { action: "upgrade", actionLabel: "Upgrade" } : {}),
    };
  }
  if (budget.level === "warning") {
    return {
      tone: "warning",
      text: `${formatPercent(budget.usedPercent ?? 0)} of this month's allowance used. ${ownerOnly ?? `Runs stop at 100% until ${reset}.`}`,
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

/** @param monthlyReset when a monthly cap is used up too, when it resets */
function storageNotice(
  budget: BudgetUsage,
  canUpgrade: boolean,
  ownerOnly: string | null,
  monthlyReset: string | null,
): Notice {
  const fix = canUpgrade ? "delete files or upgrade" : "delete files";
  const monthly =
    monthlyReset === null
      ? ""
      : ` A monthly cap is used up too, until ${monthlyReset}.`;
  const owner = ownerOnly ? ` ${ownerOnly}` : "";

  return {
    tone: budget.level === "exhausted" ? "destructive" : "warning",
    text:
      budget.level === "exhausted"
        ? `Storage limit reached. Runs are stopped and each channel got a notice. To resume, ${fix}; storage is measured once a day.${monthly}${owner}`
        : `${formatPercent(budget.shares.storageGb)} of your storage limit used. Runs stop at 100% until you ${fix}.${owner}`,
    ...(canUpgrade ? { action: "upgrade", actionLabel: "Upgrade" } : {}),
  };
}

// When it renews or resets, after its seats: what they cost for the owner,
// who pays for them for everyone else.
function planDetail(
  budget: BudgetUsage | null | undefined,
  selfHosted: boolean,
  seats: OrgSeats | undefined,
): string | null {
  if (selfHosted) return "Your own install. Every feature, no limits.";
  const billing = seats?.billing;
  if (seats && billing) {
    const day = formatDay(billing.currentPeriodEnd * 1000);
    const paidBy = seats.isOwner
      ? seatsAndPrice(seats.seats)
      : `${seats.seats} ${seats.seats === 1 ? "seat" : "seats"} · paid by ${seats.ownerName} (owner)`;
    if (billing.status === "trialing") return `${paidBy} · Trial ends ${day}`;

    return `${paidBy} · ${billing.cancelAtPeriodEnd ? "Cancels on" : "Renews on"} ${day}`;
  }
  if (!budget) return null;
  const reset = `Resets ${billingReset(budget.month)}`;
  if (!seats) return reset;

  return seats.isOwner
    ? `${reset} · 1 seat (yours)`
    : `${reset} · owner ${seats.ownerName}`;
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
