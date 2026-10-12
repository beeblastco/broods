/**
 * The active org's plan and seats as Billing and the invite dialog show them.
 * Each org pays for its own seats, one per member with the owner included,
 * and only its owner pays (`packages/convex/model/orgBilling.ts`). The
 * server checks every rule again; this only picks what to show.
 */

import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { FREE_ORG_SEATS } from "@broods/convex/model/orgBilling";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "next/navigation";

type BillingInfo = FunctionReturnType<typeof api.stripe.getBillingInfo>;

export interface OrgSeats {
  org: Doc<"orgs">;
  /** Seats and plans apply: the managed service. A self-hosted install has neither. */
  enforced: boolean;
  isOwner: boolean;
  ownerName: string;
  members: number;
  /** Seats the org has: the paid quantity, else the owner's one. */
  seats: number;
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

  return {
    org: org,
    enforced: budget?.enforced === true,
    isOwner: owner?.userId === user._id,
    ownerName: owner?.name ?? "the owner",
    members: members.length,
    seats: billing?.seats ?? FREE_ORG_SEATS,
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
