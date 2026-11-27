"use client";

import { useConvexAuth } from "convex/react";
import { useEffect } from "react";
import { useSession } from "@/app/lib/session";

let convexConfirmed = false;

// The first load needn't wait for Convex, which holds queries until it has the token; a later
// re-authentication waits, because Convex clears the token on a live socket first.
export function useSignedIn(): boolean {
  const { user } = useSession();
  const { isLoading, isAuthenticated } = useConvexAuth();

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- module flag outliving the mount
  useEffect(() => {
    if (isAuthenticated) convexConfirmed = true;
  }, [isAuthenticated]);

  return (
    user !== null &&
    user !== undefined &&
    (isAuthenticated || (isLoading && !convexConfirmed))
  );
}
