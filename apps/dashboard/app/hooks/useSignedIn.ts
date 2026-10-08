"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useConvexAuth } from "convex/react";

/**
 * Signed in as far as rendering and queries go: AuthKit has the user the
 * proxy checked, and Convex has not rejected the token. It does not wait for
 * Convex to confirm the token, since the client holds queries until it has
 * one, so gating a query on this sends it with the first batch.
 */
export function useSignedIn(): boolean {
  const { user } = useAuth();
  const { isLoading, isAuthenticated } = useConvexAuth();

  return user !== null && user !== undefined && (isLoading || isAuthenticated);
}
