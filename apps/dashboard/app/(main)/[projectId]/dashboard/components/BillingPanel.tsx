"use client";

import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { type OrgSeats, useOrgSeats } from "@/app/hooks/useOrgSeats";
import { useSubmit } from "@/app/hooks/useSubmit";
import {
  ALLOWANCE_ROWS,
  type AllowanceRow,
  BUDGET_LEVEL_TEXT,
  billingReset,
  type BudgetUsage,
  formatAmount,
  formatDay,
  formatPercent,
  poolNote,
} from "@/app/lib/allowance";
import { toErrorMessage } from "@/app/lib/errors";
import { tabHref } from "@/app/lib/navigation";
import type { PlanTier } from "@/app/lib/pricing";
import {
  DEFAULT_PLAN,
  isMaxPlan,
  perMonth,
  PLAN_CONFIGS,
  PLANS,
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
  PLAN_LIMITS,
} from "@broods/convex/model/planLimits";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useAction, useQuery } from "convex/react";
import { ArrowRight, ArrowUpRight, CreditCard, Plus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ResourceLabel } from "./AllowanceUsage";

// Stripe states where a payment is owed and the portal can fix it.
const PAYMENT_DUE_STATUSES: ReadonlySet<string | null> = new Set([
  "past_due",
  "unpaid",
  "incomplete",
]);

// What each plan allows: the monthly caps the Usage tab measures, then the
// plan's other limits.
const LIMIT_ROWS: LimitRow[] = [
  ...ALLOWANCE_ROWS.flatMap(({ key, label, unit, share, color, help }) =>
    share === null
      ? []
      : [
          {
            key: key,
            label: label,
            color: color,
            help: help,
            limit: (plan: PlanTier) => PLAN_LIMITS[plan].caps[share],
            format: (limit: number) => formatAmount(limit, unit),
          },
        ],
  ),
  {
    key: "runsPerMinute",
    label: "Runs per minute",
    limit: (plan) => PLAN_LIMITS[plan].runsPerMinute,
  },
  {
    key: "maxOwnedOrgs",
    label: "Organizations you own",
    limit: (plan) => PLAN_LIMITS[plan].maxOwnedOrgs,
  },
  {
    key: "developerSeats",
    label: "Developer seats",
    help: `Shared across every organization you own. Extra seats are ${perMonth(1)} each.`,
    limit: (plan) => (isMaxPlan(plan) ? PRO_INCLUDED_DEVELOPER_SEATS : 0),
    format: (limit) => (limit === 0 ? "None" : `${limit} included`),
  },
];

interface LimitRow extends Pick<AllowanceRow, "label" | "help"> {
  key: string;
  color?: string;
  limit: (plan: PlanTier) => number;
  /** How a limit reads; a plain count without one. */
  format?: (limit: number) => string;
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

// Checkout returns with success=true before Stripe's webhook updates the plan.
const ACTIVATING_NOTICE: Notice = {
  tone: "info",
  text: "Payment received. Activating Pro…",
};

/**
 * Billing tab: the plan table with its actions, one notice when something
 * needs attention, then the owner's seats and bill. Pro covers every org the
 * owner owns. Only the owner pays, so only the owner gets Upgrade, Add seat,
 * the portal and the bill.
 */
export function BillingPanel({ projectId }: Props): React.JSX.Element {
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const searchParams = useSearchParams();

  const seats = useOrgSeats();
  // Always this month: the Usage tab's month picker never moves the plan.
  const budget = useQuery(api.account.budget.getForActiveOrg, {});
  const createCheckoutSession = useAction(api.stripe.createCheckoutSession);
  const createPortalSession = useAction(api.stripe.createPortalSession);

  const plan: PlanTier = budget?.plan ?? DEFAULT_PLAN;
  // A subscription waiting on a payment is still Pro, held back until paid.
  const shown: PlanTier = seats?.status ? "pro" : plan;
  const isOwner = seats?.isOwner === true;
  // A live subscription in any state (even past_due) goes through the portal;
  // checkout refuses it. `undefined` is still loading, so no Upgrade yet.
  // Self-hosted installs have no plans to buy. Every member sees Upgrade on
  // a free org; only the owner can press it.
  const showUpgrade =
    seats?.status === null && !isMaxPlan(plan) && budget?.enforced === true;
  const canUpgrade = showUpgrade && isOwner;
  const ownerOnly = showUpgrade ? ownerOnlyNote(seats) : null;
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
          seats?.isOwner === false ? `Plan for ${seats.org.name}` : "Your plan"
        }
        description={planSummary(budget, seats, shown)}
      >
        <PlanCard
          budget={budget}
          current={shown}
          status={seats?.status}
          usageHref={tabHref(
            `/${projectId}/dashboard`,
            "usage",
            searchParams.toString(),
          )}
          actions={
            <PlanActions
              seats={seats}
              showUpgrade={showUpgrade}
              checkoutLoading={checkoutLoading}
              portalLoading={portalLoading}
              onUpgrade={handleUpgrade}
              onPortal={handlePortal}
            />
          }
        />
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
 * The plan table with the closest cap and `actions` under it. A skeleton
 * the card's height while the budget or the seats load, so the current plan
 * is never marked on a guess; nothing on a self-hosted install, which has no
 * limits.
 */
function PlanCard({
  budget,
  current,
  status,
  usageHref,
  actions,
}: {
  budget: BudgetUsage | null | undefined;
  current: PlanTier;
  /** The subscription's Stripe status; undefined while seats load. */
  status: string | null | undefined;
  usageHref: string;
  actions: React.ReactNode;
}): React.JSX.Element | null {
  if (budget === undefined || status === undefined) {
    return <Skeleton className="h-164 rounded-lg sm:h-88" />;
  }
  if (budget?.enforced === false) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <PlanTable current={current} status={status ?? null} />
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border px-2 py-2.5">
        <ClosestCap budget={budget} usageHref={usageHref} />
        {actions}
      </div>
    </div>
  );
}

/**
 * Every plan's limits side by side, `current` marked with its status. On a
 * phone the plans stack instead, each with its own limits, so no plan sits
 * off screen.
 */
function PlanTable({
  current,
  status,
}: {
  current: PlanTier;
  status: string | null;
}): React.JSX.Element {
  return (
    <>
      <Table className="hidden sm:table">
        <TableHeader>
          <TableRow>
            <TableHead>Limit</TableHead>
            {PLANS.map((plan) => (
              <TableHead key={plan} className="text-right">
                <PlanName plan={plan} current={current} status={status} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {LIMIT_ROWS.map((row) => (
            <TableRow key={row.key}>
              <TableCell>
                <ResourceLabel row={row} />
              </TableCell>
              {PLANS.map((plan) => (
                <TableCell key={plan} className="text-right">
                  <LimitValue row={row} plan={plan} current={current} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="grid divide-y divide-border text-sm sm:hidden">
        {PLANS.map((plan) => (
          <div key={plan}>
            <div className="px-2 py-2.5 font-medium">
              <PlanName plan={plan} current={current} status={status} />
            </div>
            {LIMIT_ROWS.map((row) => (
              <div
                key={row.key}
                className="flex items-center justify-between gap-4 border-t border-border px-2 py-2"
              >
                <ResourceLabel row={row} />
                <LimitValue row={row} plan={plan} current={current} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
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
          className={owner ? "cursor-pointer" : "cursor-not-allowed"}
          onClick={onUpgrade}
          disabled={checkoutLoading || !owner}
        >
          <ArrowUpRight className="size-3.5" />
          {checkoutLoading ? "Loading…" : "Upgrade to Pro"}
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
        Add seat for {perMonth(1)}
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
 * The owner's developer seats, one pool across every org they own: how many
 * are used, each developer with the orgs they are in, and Add seat once every
 * one is taken, then on Pro what they pay each month. Hobby has none, which
 * the plan table already says, so it shows only developers kept from before
 * seats counted, with what Upgrade pays for them. Anyone else sees only their
 * own seat. Nothing on an install without seats.
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
  if (!billing && developers === 0) return null;
  const canAdd = paid && seats.seatsToAdd > 0;
  const rows = holders ?? [];

  return (
    <>
      <Section title="Developer seats" description={seatsDescription(seats)}>
        {(rows.length > 0 || canAdd) && (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {rows.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Developer</TableHead>
                    <TableHead>Organizations</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((holder) => (
                    <TableRow key={holder.userId}>
                      <TableCell>{holder.name}</TableCell>
                      <TableCell>
                        <span className="text-muted-foreground">
                          {holder.orgs.join(", ")}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {canAdd && (
              <div className="flex justify-end border-t border-border px-2 py-2.5">
                <AddSeatButton seats={seats} />
              </div>
            )}
          </div>
        )}
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
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>
                <span className="text-muted-foreground">
                  Pro plan (includes {PRO_INCLUDED_DEVELOPER_SEATS} developer
                  seats)
                </span>
              </TableCell>
              <TableCell className="text-right">
                <span className="tabular-nums">{perMonth(1)}</span>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <span className="text-muted-foreground">
                  Extra seats ({extraSeats} × {perMonth(1)})
                </span>
              </TableCell>
              <TableCell className="text-right">
                <span className="tabular-nums">{perMonth(extraSeats)}</span>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <span className="font-semibold">Total</span>
              </TableCell>
              <TableCell className="text-right">
                <span className="font-semibold tabular-nums">
                  {perMonth(1 + extraSeats)}
                </span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </Section>
  );
}

// How close the pool is to its closest cap, and a link to the Usage tab.
function ClosestCap({
  budget,
  usageHref,
}: {
  budget: BudgetUsage | null;
  usageHref: string;
}): React.JSX.Element {
  const used = budget?.usedPercent;

  return (
    <div className="flex items-center gap-3">
      {budget && used != null && (
        <span
          className={cn(
            "text-xs tabular-nums",
            BUDGET_LEVEL_TEXT[budget.level],
          )}
        >
          {formatPercent(used)} used
        </span>
      )}
      <Button
        nativeButton={false}
        render={<Link href={usageHref} />}
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

// One plan's value for a limit, muted unless it is the current plan's.
function LimitValue({
  row,
  plan,
  current,
}: {
  row: LimitRow;
  plan: PlanTier;
  current: PlanTier;
}): React.JSX.Element {
  const limit = row.limit(plan);

  return (
    <span
      className={cn(
        "tabular-nums",
        plan !== current && "text-muted-foreground",
      )}
    >
      {row.format?.(limit) ?? limit.toLocaleString()}
    </span>
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

// A plan's name and price, with its mark when it is the current one.
function PlanName({
  plan,
  current,
  status,
}: {
  plan: PlanTier;
  current: PlanTier;
  status: string | null;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      {PLAN_CONFIGS[plan].label}
      <span className="font-normal text-muted-foreground">
        {PLAN_CONFIGS[plan].price}
      </span>
      {plan === current && <PlanBadge status={status} />}
    </span>
  );
}

// The current plan's mark: its subscription state when one needs a word,
// Current otherwise.
function PlanBadge({ status }: { status: string | null }): React.JSX.Element {
  if (status === "trialing") return <Badge variant="info">Trial</Badge>;
  if (PAYMENT_DUE_STATUSES.has(status)) {
    return <Badge variant="destructive">Payment due</Badge>;
  }

  return <Badge variant="secondary">Current</Badge>;
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

// What a member of a free org hears instead of a checkout; null for the owner.
function ownerOnlyNote(seats: OrgSeats | undefined): string | null {
  if (!seats || seats.isOwner) return null;

  return `Only ${seats.ownerName}, the owner, can upgrade ${seats.org.name}. You are not charged.`;
}

// The plan's price and when it renews, or when a free one resets, for the
// owner; for anyone else, whose plan it is and that they are not charged.
function planDetail(
  budget: BudgetUsage | null,
  seats: OrgSeats | undefined,
  plan: PlanTier,
): string | null {
  if (seats && !seats.isOwner) {
    return `This org runs on ${seats.ownerName}'s ${PLAN_CONFIGS[plan].label} plan. You are not charged.`;
  }
  const billing = seats?.billing;
  if (billing) {
    if (!seats?.paid) return "On hold until Stripe has the payment.";
    const day = formatDay(billing.currentPeriodEnd * 1000);
    const when =
      billing.status === "trialing"
        ? "Trial ends"
        : billing.cancelAtPeriodEnd
          ? "Cancels"
          : "Renews";

    return `${when} ${day}.`;
  }
  if (!budget) return null;
  const reset = `Resets ${billingReset(budget.month)}.`;
  if (!seats) return reset;
  const who = seats.members === 1 ? "Just you" : `${seats.members} members`;

  return `${reset} ${who} in this org.`;
}

// The line under the plan's heading: what it costs and when it renews or
// resets, then whose limits these are, the same note as the Usage tab.
// Nothing until the budget and seats are known, so the line never swaps
// under the reader.
function planSummary(
  budget: BudgetUsage | null | undefined,
  seats: OrgSeats | undefined,
  plan: PlanTier,
): string | undefined {
  if (budget === undefined || seats === undefined) return undefined;
  if (budget?.enforced === false) {
    return "Your own install. Every feature, no limits.";
  }
  const note =
    (budget ? poolNote(budget) : null) ??
    (seats?.isOwner && seats.billing
      ? "Covers every organization you own."
      : null);

  return [planDetail(budget, seats, plan), note]
    .filter((part) => part !== null)
    .join(" ");
}

// The owner's seats in one line: how many are used and where they come from,
// on hold while a payment is owed, or on Hobby the developers kept from
// before seats counted and what Upgrade charges for them.
function seatsDescription(seats: OrgSeats): string {
  const { billing, developers, extraSeats, paid } = seats;
  if (paid) {
    const extra = extraSeats > 0 ? ` and ${extraSeats} extra` : "";

    return `${developers} of ${seats.seats} developer seats used across your orgs. ${PRO_INCLUDED_DEVELOPER_SEATS} included with Pro${extra}.`;
  }
  if (billing) {
    return "Seats on hold until Stripe has the payment.";
  }
  const who = developers === 1 ? "developer" : "developers";

  return `${developers} ${who} kept from before seats counted. Upgrading charges ${perMonth(proQuantity(developers))} for all of them; no new invites until then.`;
}
