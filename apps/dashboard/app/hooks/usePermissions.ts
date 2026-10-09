/**
 * What the signed-in member may do in the dashboard for the active org:
 * everything by tier for owners and admins, and for a member what their
 * custom role's policies allow, org-wide or in one project. `can` is false
 * while loading, so a gated control never flashes for someone who may not
 * use it.
 */

import { useSignedIn } from "@/app/hooks/useSignedIn";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { DashboardPolicyAction } from "@broods/convex/model/policyRules";
import { useQuery } from "convex/react";

export function usePermissions(projectId?: Id<"projects">): {
  can: (action: DashboardPolicyAction) => boolean;
} {
  const signedIn = useSignedIn();
  const held = useQuery(
    api.access.viewerPermissions,
    signedIn ? { projectId: projectId } : "skip",
  );

  return { can: (action) => held?.includes(action) ?? false };
}
