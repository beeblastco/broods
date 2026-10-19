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
  poolNote,
} from "@/app/lib/allowance";
import { toErrorMessage } from "@/app/lib/errors";
import type { PlanTier } from "@/app/lib/pricing";
import {
  DEFAULT_PLAN,
  isMaxPlan,
  perMonth,
  PLAN_CONFIGS,
  PRO_OFFER,
  seatCount,
} from "@/app/lib/pricing";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { clientErrorData } from "@broods/convex/model/clientError";
import {
  PRO_INCLUDED_DEVELOPER_SEATS,
  proQuantity,
} from "@broods/convex/model/orgBilling";
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
const PAYMENT_DUE_STATUSES: ReadonlySet<string | null> = new Set([
  "past_due",
  "unpaid",
  "incomplete",
]);

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
 * Billing tab, in separate parts: the plan with its price and one bar for
 * the active org's closest cap, then a single notice when something needs
 * attention, then the owner's developer seats, then what they pay each
 * month. Pro belongs to the owner and covers every org they own, with one
 * seat pool across them. Every member sees the plan and their own seat; only
 * the owner pays, so only the owner gets Upgrade, Add seat, the portal and
 * the bill. The per-resource allowance lives on the Usage tab, which the bar
 * links to.
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

  const plan: PlanTier = budget?.plan ?? DEFAULT_PLAN;
  const isOwner = seats?.isOwner === true;
  // A live subscription in any state (even past_due) goes through the portal;
  // checkout refuses it. `undefined` is still loading, so no Upgrade yet.
  // Self-hosted installs have no plans to buy. Every member sees Upgrade on
  // a free org; only the owner can press it.
  const showUpgrade =
    seats?.status === null && !isMaxPlan(plan) && budget?.enforced === true;
  const canUpgrade = showUpgrade && isOwner;
  // What a member of a free org hears instead of a checkout.
  const ownerOnly =
    showUpgrade && seats && !isOwner
      ? `Only ${seats.ownerName}, the owner, can upgrade ${seats.org.name}. You are not charged.`
      : null;
  const notice = pickNotice(
    budget,
    seats,
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
      <Section
        // Someone else's org names the org: its plan is the owner's.
        title={
          seats?.isOwner === false ? `Plan · ${seats.org.name}` : "Your plan"
        }
      >
        <div className="grid gap-4 rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
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

      <SeatsSection seats={seats} />
    </div>
  );
}

/**
 * The owner's actions on the plan: the portal once the org has a
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

  return (
    <div className="flex shrink-0 items-center gap-2">
      {owner && seats?.billing && (
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
          {checkoutLoading
            ? "Loading…"
            : owner
              ? `Upgrade to Pro · ${perMonth(proQuantity(seats.developers))}`
              : "Upgrade to Pro"}
        </Button>
      )}
    </div>
  );
}

/**
 * The owner's Add seat, behind one confirm: Stripe charges the prorated seats
 * at once, and adds them only when that payment goes through. Shown only with
 * every seat taken: a free seat already takes the next developer.
 */
function AddSeatButton({ seats }: { seats: OrgSeats }): React.JSX.Element {
  const { seatsToAdd } = seats;
  const [confirming, setConfirming] = useState(false);
  const { pending, error, run } = useSubmit();
  const addSeat = useAction(api.stripe.addSeat);

  async function confirm(): Promise<void> {
    if (await run(() => addSeat({}))) setConfirming(false);
  }

  return (
    <>
      <Button
        size="sm"
        className="cursor-pointer"
        onClick={() => setConfirming(true)}
      >
        <Plus className="size-3.5" />
        Add seat · {perMonth(1)}
      </Button>
      {confirming && (
        <ConfirmDialog
          title="Add a developer seat"
          description={`Add ${seatCount(seatsToAdd)} for ${perMonth(seatsToAdd)}, to use in any of your orgs. You are charged now for the rest of this period.`}
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

/**
 * The owner's developer seats, one pool across every org they own. For the
 * owner: how many are used, each developer with the orgs they are in, and
 * Add seat once every one is taken, then on Pro what they pay each month. On
 * Hobby there are none, and developers kept from before seats counted are
 * listed with what Upgrade pays for them. Anyone else sees only their own
 * seat. Nothing on an install without seats.
 */
function SeatsSection({
  seats,
}: {
  seats: OrgSeats | undefined;
}): React.JSX.Element | null {
  const owner = seats?.enforced === true && seats.isOwner;
  const holders = useQuery(api.stripe.listSeatHolders, owner ? {} : "skip");
  if (!seats?.enforced) return null;
  if (!seats.isOwner) return <YourSeat seats={seats} />;
  const { billing, developers, extraSeats, paid } = seats;
  const [headline, detail] = paid
    ? [
        `${developers} of ${seats.seats} developer seats used across your orgs`,
        `${PRO_INCLUDED_DEVELOPER_SEATS} included with Pro${extraSeats > 0 ? ` and ${extraSeats} extra` : ""}`,
      ]
    : billing
      ? [
          "Seats on hold",
          "The seats come back once Stripe has the payment. Update the card in Manage subscription.",
        ]
      : ["No developer seats on Hobby", PRO_OFFER];

  return (
    <>
      <Section title="Developer seats">
        <div className="grid gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="grid gap-0.5">
              <span className="text-sm font-semibold text-foreground">
                {headline}
              </span>
              <p className="text-xs text-muted-foreground">{detail}</p>
              {!billing && developers > 0 && (
                <p className="text-xs text-muted-foreground">
                  {`${developers} ${developers === 1 ? "developer" : "developers"} kept from before seats counted. Upgrading charges ${perMonth(proQuantity(developers))} for all of them; no new invites until then.`}
                </p>
              )}
            </div>
            {paid && seats.seatsToAdd > 0 && <AddSeatButton seats={seats} />}
          </div>
          {holders && holders.length > 0 && (
            <ul className="grid border-t border-border">
              {holders.map((holder) => (
                <li
                  key={holder.userId}
                  className="flex items-center justify-between gap-4 border-b border-border py-2 text-xs last:border-b-0"
                >
                  <span className="truncate text-foreground">
                    {holder.name}
                  </span>
                  <span className="truncate text-muted-foreground">
                    {holder.orgs.join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>
      {paid && <MonthlyBill extraSeats={extraSeats} />}
    </>
  );
}

/** A member's own seat in someone else's org: who pays for it. The plan already says they never do. */
function YourSeat({ seats }: { seats: OrgSeats }): React.JSX.Element {
  const own =
    seats.userPlan === "free"
      ? "Your own Hobby plan stays free and separate."
      : "Your own Pro plan is billed separately.";
  const paidBy = seats.paid
    ? `A developer seat from ${seats.ownerName}'s Pro plan.`
    : `A seat in ${seats.ownerName}'s org.`;

  return (
    <Section title="Your seat">
      <div className="grid gap-0.5 rounded-lg border border-border bg-card px-4 py-3">
        <span className="text-sm font-semibold text-foreground">
          Developer seat in {seats.org.name}
        </span>
        <p className="text-xs text-muted-foreground">
          {paidBy} {own}
        </p>
      </div>
    </Section>
  );
}

/** The owner's monthly bill, for every org they own: Pro, the extra seats, and the total. */
function MonthlyBill({
  extraSeats,
}: {
  extraSeats: number;
}): React.JSX.Element {
  return (
    <Section title="What you pay each month">
      <div className="grid rounded-lg border border-border bg-card px-4 py-1 text-xs">
        <div className="flex justify-between gap-4 border-b border-border py-2 text-muted-foreground">
          <span>
            Pro plan (includes {PRO_INCLUDED_DEVELOPER_SEATS} developer seats)
          </span>
          <span className="tabular-nums">{perMonth(1)}</span>
        </div>
        <div className="flex justify-between gap-4 border-b border-border py-2 text-muted-foreground">
          <span>
            Extra seats · {extraSeats} × {perMonth(1)}
          </span>
          <span className="tabular-nums">{perMonth(extraSeats)}</span>
        </div>
        <div className="flex justify-between gap-4 py-2 font-semibold text-foreground">
          <span>Total</span>
          <span className="tabular-nums">{perMonth(1 + extraSeats)}</span>
        </div>
      </div>
    </Section>
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

// Only a state worth a word: a paid plan in good standing and a free one show
// none, and who pays is plain text in the summary.
function PlanBadge({
  selfHosted,
  status,
}: {
  selfHosted: boolean;
  status: string | undefined;
}): React.JSX.Element | null {
  if (selfHosted) return <Badge variant="secondary">Unlimited</Badge>;
  if (status === "trialing") return <Badge variant="info">Trial</Badge>;
  if (status === "active") return null;
  if (status && PAYMENT_DUE_STATUSES.has(status)) {
    return <Badge variant="destructive">Payment due</Badge>;
  }

  return null;
}

// Plan name, status, what it costs and when it renews or resets, and whose
// limits these are: the same note line as the Usage tab.
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
  // A subscription waiting on a payment is still Pro, held back until paid.
  const shown: PlanTier = seats?.status ? "pro" : plan;
  const detail = planDetail(budget, selfHosted, shown, seats);
  // Nothing until the budget is known, so the line never swaps under the reader.
  const note =
    budget === undefined
      ? null
      : ((budget ? poolNote(budget) : null) ??
        (seats?.isOwner && seats.billing && !selfHosted
          ? "Covers every organization you own."
          : null));

  return (
    <div className="grid gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">
          {selfHosted ? "Self-hosted" : PLAN_CONFIGS[shown].label}
        </span>
        <PlanBadge
          selfHosted={selfHosted}
          status={seats?.status ?? undefined}
        />
      </div>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

// The one notice worth showing, most urgent first. `checkoutReturned` is the
// success=true Stripe adds to the checkout return URL; a payment due outranks
// it, since the URL keeps that flag after the subscription later fails.
// `ownerOnly` tells a member of a free org who can upgrade it. The status is
// for every member; `billing`, with a trial's end, is the owner's alone.
function pickNotice(
  budget: BudgetUsage | null | undefined,
  seats: OrgSeats | undefined,
  canUpgrade: boolean,
  ownerOnly: string | null,
  plan: PlanTier,
  checkoutReturned: boolean,
): Notice | null {
  const { status, billing } = seats ?? { status: null, billing: null };
  if (PAYMENT_DUE_STATUSES.has(status)) {
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
  if (billing?.status === "trialing") {
    return {
      tone: "info",
      text: `Pro trial ends ${formatDay(billing.currentPeriodEnd * 1000)}. Keep a card on file to stay on Pro.`,
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

// The plan's price and when it renews, or when a free one resets, for the
// owner; for anyone else, whose plan it is and that they are not charged.
function planDetail(
  budget: BudgetUsage | null | undefined,
  selfHosted: boolean,
  plan: PlanTier,
  seats: OrgSeats | undefined,
): string | null {
  if (selfHosted) return "Your own install. Every feature, no limits.";
  if (seats && !seats.isOwner) {
    return `This org runs on ${seats.ownerName}'s ${PLAN_CONFIGS[plan].label} plan. You are not charged.`;
  }
  const billing = seats?.billing;
  if (billing) {
    if (!seats?.paid) {
      return `${perMonth(1)} · on hold until Stripe has the payment`;
    }
    const day = formatDay(billing.currentPeriodEnd * 1000);
    const when =
      billing.status === "trialing"
        ? "trial ends"
        : billing.cancelAtPeriodEnd
          ? "cancels"
          : "renews";

    return `${perMonth(1)} · ${when} ${day}`;
  }
  if (!budget) return null;
  const reset = `Resets ${billingReset(budget.month)}`;
  if (!seats) return reset;
  const who = seats.members === 1 ? "just you" : `${seats.members} members`;

  return `${reset} · ${who} · you can join other people's orgs`;
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
