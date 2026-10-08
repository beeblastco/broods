"use client";

import { useConvexAuth } from "convex/react";
import { useEffect } from "react";
import { useSession } from "@/app/lib/session";

// Set once Convex has confirmed the session in this page load.
let convexConfirmed = false;

/**
 * Signed in as far as rendering and queries go: the session (AuthKit, or a
 * self-hosted stack's admin key) has the user the proxy checked, and Convex has not rejected the token. On the first load it
 * does not wait for Convex to confirm, since the client holds queries until
 * it has the token; a later re-authentication waits, because Convex clears
 * the token on a live socket first.
 */
export function useSignedIn(): boolean {
  const { user } = useSession();
  const { isLoading, isAuthenticated } = useConvexAuth();

  useEffect(() => {
    if (isAuthenticated) convexConfirmed = true;
  }, [isAuthenticated]);

  return (
    user !== null &&
    user !== undefined &&
    (isAuthenticated || (isLoading && !convexConfirmed))
  );
}
