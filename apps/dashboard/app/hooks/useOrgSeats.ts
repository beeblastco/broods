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
  enforced: boolean;
  isOwner: boolean;
  ownerName: string;
  userPlan: Doc<"users">["plan"];
  members: number;
  status: string | null;
  paid: boolean;
  developers: number;
  seats: number;
  extraSeats: number;
  seatsToAdd: number;
  billing: Subscription;
}

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
  const pool =
    info?.kind === "owner"
      ? info
      : { seats: 0, developers: 0, subscription: null };
  const status =
    info?.kind === "member" ? info.status : (pool.subscription?.status ?? null);
  const { seats, developers } = pool;

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
    billing: pool.subscription,
  };
}

export function useOpenBilling(): (orgId: Id<"orgs">) => Promise<void> {
  const setActive = useMutation(api.org.orgs.setActive);
  const router = useRouter();

  return async (orgId) => {
    await setActive({ orgId: orgId });
    router.push("/?tab=billing");
  };
}
