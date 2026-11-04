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
