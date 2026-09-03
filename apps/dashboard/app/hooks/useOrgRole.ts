/**
 * The caller's role in the active org. `canWrite` hides admin-only controls
 * from members; every mutation checks the role again server-side.
 */

import { api } from "@broods/convex/_generated/api";
import { useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";

type ActiveAccount = NonNullable<
  FunctionReturnType<typeof api.org.orgs.getActiveAccount>
>;

export interface OrgRoleState {
  role: ActiveAccount["role"] | null;
  /** False while loading, so write controls never flash for a member. */
  canWrite: boolean;
}

export function useOrgRole(): OrgRoleState {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const active = useQuery(
    api.org.orgs.getActiveAccount,
    !isLoading && isAuthenticated ? {} : "skip",
  );
  const role = active?.role ?? null;

  return {
    role: role,
    canWrite: role !== null && role !== "member",
  };
}
