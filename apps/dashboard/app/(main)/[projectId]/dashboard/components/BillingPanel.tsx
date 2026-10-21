"use client";

import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { HelpMark } from "@/app/components/HelpMark";
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
  billingReset,
  type BudgetUsage,
  formatAmount,
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
import { ALLOWANCE_ROWS } from "./AllowanceUsage";

// Stripe states where a payment is owed and the portal can fix it.
const PAYMENT_DUE_STATUSES: ReadonlySet<string | null> = new Set([
  "past_due",
  "unpaid",
  "incomplete",
]);

// The plans side by side, cheapest first.
const PLANS: PlanTier[] = Object.values(PLAN_CONFIGS)
  .toSorted((a, b) => a.order - b.order)
  .map((config) => config.key);

// What each plan allows: the monthly caps the Usage tab measures, then the
// plan's other limits.
const LIMIT_ROWS: LimitRow[] = [
  ...ALLOWANCE_ROWS.flatMap((row) => {
    const share = row.share;
    if (share === null) return [];

    return [
      {
        key: row.key,
        label: row.label,
        color: row.color,
        help: row.help,
        limit: (plan: PlanTier) => PLAN_LIMITS[plan].caps[share],
        format: (limit: number) => formatAmount(limit, row.unit),
      },
    ];
  }),
  {
    key: "runsPerMinute",
    label: "Runs per minute",
    limit: (plan) => PLAN_LIMITS[plan].runsPerMinute,
    format: (limit) => limit.toLocaleString(),
  },
  {
    key: "maxOwnedOrgs",
    label: "Organizations you own",
    limit: (plan) => PLAN_LIMITS[plan].maxOwnedOrgs,
    format: (limit) => limit.toLocaleString(),
  },
  {
    key: "developerSeats",
    label: "Developer seats",
    help: `Shared across every organization you own. Extra seats are ${perMonth(1)} each.`,
    limit: (plan) => (isMaxPlan(plan) ? PRO_INCLUDED_DEVELOPER_SEATS : 0),
    format: (limit) => (limit === 0 ? "None" : `${limit} included`),
  },
];

interface LimitRow {
  key: string;
  label: string;
  color?: string;
  help?: string;
  limit: (plan: PlanTier) => number;
  format: (limit: number) => string;
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
 * Billing tab, in separate parts: the plan as a table of what each plan
 * allows, the current one marked, with the active org's closest cap and the
 * plan's actions under it, then a single notice when something needs
 * attention, then the owner's developer seats, then what they pay each
 * month. Pro belongs to the owner and covers every org they own, with one
 * seat pool across them. Every member sees the plan and their own seat; only
 * the owner pays, so only the owner gets Upgrade, Add seat, the portal and
 * the bill. The per-resource usage lives on the Usage tab, which the plan
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
          seats?.isOwner === false ? `Plan for ${seats.org.name}` : "Your plan"
        }
        description={planSummary(budget, seats)}
      >
        <PlanCard
          budget={budget}
          seats={seats}
          projectId={projectId}
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
 * while the budget loads; nothing on a self-hosted install, which has no
 * limits.
 */
function PlanCard({
  budget,
  seats,
  projectId,
  actions,
}: {
  budget: BudgetUsage | null | undefined;
  seats: OrgSeats | undefined;
  projectId: Id<"projects">;
  actions: React.ReactNode;
}): React.JSX.Element | null {
  if (budget === undefined) return <Skeleton className="h-80 rounded-lg" />;
  if (budget?.enforced === false) return null;
  const current = shownPlan(budget, seats);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <PlanTable current={current} status={seats?.status ?? null} />
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border px-4 py-2.5">
        <ClosestCap budget={budget} projectId={projectId} />
        {actions}
      </div>
    </div>
  );
}

/**
 * Every plan's limits side by side, `current` marked with its status. On a
 * cheaper plan, each limit a better plan raises says by how much.
 */
function PlanTable({
  current,
  status,
}: {
  current: PlanTier;
  status: string | null;
}): React.JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Limit</TableHead>
          {PLANS.map((plan) => (
            <TableHead key={plan} className="text-right">
              <span className="inline-flex items-center gap-2">
                {PLAN_CONFIGS[plan].label}
                <span className="font-normal text-muted-foreground">
                  {isMaxPlan(plan) ? perMonth(1) : "Free"}
                </span>
                {plan === current && <PlanBadge status={status} />}
              </span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {LIMIT_ROWS.map((row) => (
          <TableRow key={row.key}>
            <TableCell>
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
            </TableCell>
            {PLANS.map((plan) => (
              <TableCell key={plan} className="text-right">
                <span
                  className={cn(
                    "tabular-nums",
                    plan !== current && "text-muted-foreground",
                  )}
                >
                  {row.format(row.limit(plan))}
                </span>
                <Gain row={row} plan={plan} current={current} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
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

  return (
    <>
      <Section title="Developer seats" description={seatsDescription(seats)}>
        {((holders && holders.length > 0) || canAdd) && (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {holders && holders.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Developer</TableHead>
                    <TableHead>Organizations</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {holders.map((holder) => (
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
              <div className="flex justify-end border-t border-border px-4 py-2.5">
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

// How close the pool is to its closest cap, linking to the full allowance.
// Nothing on an install with no caps.
function ClosestCap({
  budget,
  projectId,
}: {
  budget: BudgetUsage | null;
  projectId: Id<"projects">;
}): React.JSX.Element {
  const searchParams = useSearchParams();
  const used = budget?.usedPercent;

  return (
    <div className="flex items-center gap-3">
      {used != null && (
        <span
          className={cn(
            "text-xs tabular-nums",
            budget?.level === "ok" && "text-muted-foreground",
            budget?.level === "warning" && "text-warning",
            budget?.level === "exhausted" && "text-destructive",
          )}
        >
          {formatPercent(used)} of the closest limit used
        </span>
      )}
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

// How many times `current`'s limit `plan` gives, on the better plan's cell
// only, when it is a raise.
function Gain({
  row,
  plan,
  current,
}: {
  row: LimitRow;
  plan: PlanTier;
  current: PlanTier;
}): React.JSX.Element | null {
  const base = row.limit(current);
  const ratio = row.limit(plan) / base;
  if (PLAN_CONFIGS[plan].order <= PLAN_CONFIGS[current].order) return null;
  if (base === 0 || ratio <= 1) return null;

  return (
    <span className="ml-1.5 text-2xs text-success">{Math.round(ratio)}×</span>
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
    if (!seats?.paid) {
      return `${perMonth(1)}, on hold until Stripe has the payment.`;
    }
    const day = formatDay(billing.currentPeriodEnd * 1000);
    const when =
      billing.status === "trialing"
        ? "trial ends"
        : billing.cancelAtPeriodEnd
          ? "cancels"
          : "renews";

    return `${perMonth(1)}, ${when} ${day}.`;
  }
  if (!budget) return null;
  const reset = `Resets ${billingReset(budget.month)}.`;
  if (!seats) return reset;
  const who = seats.members === 1 ? "Just you" : `${seats.members} members`;

  return `${reset} ${who}, and you can join other people's orgs.`;
}

// The line under the plan's heading: what it costs and when it renews or
// resets, then whose limits these are, the same note as the Usage tab.
// Nothing until the budget is known, so the line never swaps under the reader.
function planSummary(
  budget: BudgetUsage | null | undefined,
  seats: OrgSeats | undefined,
): string | undefined {
  if (budget === undefined) return undefined;
  if (budget?.enforced === false) {
    return "Your own install. Every feature, no limits.";
  }
  const plan = shownPlan(budget, seats);
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
    return "Seats on hold. They come back once Stripe has the payment. Update the card in Manage subscription.";
  }
  const who = developers === 1 ? "developer" : "developers";

  return `${developers} ${who} kept from before seats counted. Upgrading charges ${perMonth(proQuantity(developers))} for all of them; no new invites until then.`;
}

// The plan to show: a subscription waiting on a payment is still Pro, held
// back until paid.
function shownPlan(
  budget: BudgetUsage | null,
  seats: OrgSeats | undefined,
): PlanTier {
  return seats?.status ? "pro" : (budget?.plan ?? DEFAULT_PLAN);
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
