/**
 * The active org's plan and its owner's developer seats as Billing and the
 * invite dialog show them. Pro belongs to the owner and covers every org they
 * own: it includes `PRO_INCLUDED_DEVELOPER_SEATS` developer seats, shared
 * across those orgs, and each seat past those is extra. Hobby has none
 * (`packages/convex/model/orgBilling.ts`). The server checks every rule
 * again; this only picks what to show.
 */

import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { isPaid, seatsForQuantity } from "@broods/convex/model/orgBilling";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "next/navigation";

type Subscription = Extract<
  NonNullable<FunctionReturnType<typeof api.stripe.getBillingInfo>>,
  { kind: "owner" }
>["subscription"];

export interface OrgSeats {
  org: Doc<"orgs">;
  /** Seats and plans apply: the managed service. A self-hosted install has neither. */
  enforced: boolean;
  isOwner: boolean;
  ownerName: string;
  /** The viewer's own plan, apart from this org's. */
  userPlan: Doc<"users">["plan"];
  /** Members of this org, owner included. */
  members: number;
  /** The owner's subscription status while it has not ended, else null. Every member sees it. */
  status: string | null;
  /** The owner's subscription is paid, so their seats count. */
  paid: boolean;
  // The pool and the subscription's period are the owner's alone: for
  // anyone else they read 0 and null.
  /** Developers across every org the owner owns, each once. */
  developers: number;
  /** Developer seats the owner has: Pro's included ones plus the extra paid ones, else none. */
  seats: number;
  /** Seats paid past the ones Pro includes. */
  extraSeats: number;
  /** Seats Add seat buys: enough for every developer plus one more (`stripe.addSeat`). */
  seatsToAdd: number;
  /** The viewer's own subscription that has not ended, when they own the org. */
  billing: Subscription;
}

/** @returns undefined while any part loads */
export function useOrgSeats(): OrgSeats | undefined {
  const org = useQuery(api.org.orgs.getActive, {});
  const user = useQuery(api.user.getCurrent);
  const members = useQuery(
    api.org.members.list,
    org ? { orgId: org._id } : "skip",
  );
  const info = useQuery(api.stripe.getBillingInfo);
  const budget = useQuery(api.account.budget.getForActiveOrg, {});
  if (!org || !user || !members || info === undefined) return undefined;
  if (budget === undefined) return undefined;
  const owner = members.find((member) => member.isOwner);
  const pool = info?.kind === "owner" ? info : null;
  const status =
    info?.kind === "member"
      ? info.status
      : (pool?.subscription?.status ?? null);
  const seats = pool?.seats ?? 0;
  const developers = pool?.developers ?? 0;

  return {
    org: org,
    enforced: budget?.enforced === true,
    isOwner: owner?.userId === user._id,
    ownerName: owner?.name ?? "the owner",
    userPlan: user.plan,
    members: members.length,
    status: status,
    paid: status !== null && isPaid(status),
    developers: developers,
    seats: seats,
    extraSeats: Math.max(0, seats - seatsForQuantity(1)),
    seatsToAdd: Math.max(seats, developers + 1) - seats,
    billing: pool?.subscription ?? null,
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
