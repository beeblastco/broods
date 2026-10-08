/**
 * What the signed-in member may do in the dashboard for the active org:
 * everything by tier for owners and admins, and for a member what their
 * custom role's policies allow. `can` is false while loading, so a gated
 * control never flashes for someone who may not use it.
 */

import { api } from "@broods/convex/_generated/api";
import type { DashboardPolicyAction } from "@broods/convex/model/policyRules";
import { useConvexAuth, useQuery } from "convex/react";

export function usePermissions(): {
  can: (action: DashboardPolicyAction) => boolean;
  loaded: boolean;
} {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const held = useQuery(
    api.access.viewerPermissions,
    !isLoading && isAuthenticated ? {} : "skip",
  );

  return {
    can: (action) => held?.includes(action) ?? false,
    loaded: held !== undefined,
  };
}
