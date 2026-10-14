/**
 * The active org's plan and seats as Billing and the invite dialog show them.
 * Each org pays for its own plan, and only its owner pays: Pro seats the
 * owner and `PRO_INCLUDED_DEVELOPER_SEATS` developers, each seat past those
 * is extra, and Hobby seats the owner only
 * (`packages/convex/model/orgBilling.ts`). The server checks every rule
 * again; this only picks what to show.
 */

import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import {
  FREE_ORG_SEATS,
  isPaid,
  PRO_INCLUDED_DEVELOPER_SEATS,
} from "@broods/convex/model/orgBilling";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "next/navigation";

type BillingInfo = FunctionReturnType<typeof api.stripe.getBillingInfo>;

/** What pays for a member's seat: the owner's own, one Pro includes, or an extra one. */
export type SeatKind = "owner" | "included" | "extra";

export interface SeatHolder {
  userId: Id<"users">;
  name: string;
  seat: SeatKind;
}

export interface OrgSeats {
  org: Doc<"orgs">;
  /** Seats and plans apply: the managed service. A self-hosted install has neither. */
  enforced: boolean;
  isOwner: boolean;
  ownerName: string;
  /** The viewer's own plan, apart from this org's. */
  userPlan: Doc<"users">["plan"];
  members: number;
  /** Every member, owner first, with what pays for their seat. */
  holders: SeatHolder[];
  /** The viewer's seat, or undefined while they hold none. */
  yours: SeatKind | undefined;
  /** Seats the org has: Pro's included ones plus the extra paid ones, else the owner's one. */
  seats: number;
  /** Seats paid past the ones Pro includes. */
  extraSeats: number;
  /** The org's subscription is paid, so its seats count. */
  paid: boolean;
  /** Seats Add seat buys: enough for every member plus one more (`stripe.addSeat`). */
  seatsToAdd: number;
  /** The org's subscription that has not ended, or null when it has none. */
  billing: BillingInfo;
}

/** @returns undefined while any part loads */
export function useOrgSeats(): OrgSeats | undefined {
  const org = useQuery(api.org.orgs.getActive, {});
  const user = useQuery(api.user.getCurrent);
  const members = useQuery(
    api.org.members.list,
    org ? { orgId: org._id } : "skip",
  );
  const billing = useQuery(api.stripe.getBillingInfo);
  const budget = useQuery(api.account.budget.getForActiveOrg, {});
  if (!org || !user || !members || billing === undefined) return undefined;
  if (budget === undefined) return undefined;
  const owner = members.find((member) => member.isOwner);
  const seats = billing?.seats ?? FREE_ORG_SEATS;
  // The list puts the owner first, then members by when they joined: the
  // first ones past the owner sit on the seats Pro includes.
  const holders = members.map((member, index): SeatHolder => ({
    userId: member.userId,
    name: member.name,
    seat: member.isOwner
      ? "owner"
      : index <= PRO_INCLUDED_DEVELOPER_SEATS
        ? "included"
        : "extra",
  }));

  return {
    org: org,
    enforced: budget?.enforced === true,
    isOwner: owner?.userId === user._id,
    ownerName: owner?.name ?? "the owner",
    userPlan: user.plan,
    members: members.length,
    holders: holders,
    yours: holders.find((holder) => holder.userId === user._id)?.seat,
    seats: seats,
    extraSeats: billing?.extraSeats ?? 0,
    paid: billing !== null && isPaid(billing.status),
    seatsToAdd: Math.max(seats, members.length + 1) - seats,
    billing: billing,
  };
}

/** Open an org's Billing tab: make it the active org, then let home pick its project. */
export function useOpenBilling(): (orgId: Id<"orgs">) => Promise<void> {
  const setActive = useMutation(api.org.orgs.setActive);
  const router = useRouter();

  return async (orgId) => {
    await setActive({ orgId: orgId });
    router.push("/?tab=billing");
  };
}
