/** Shoo auth module wired for ConvexProviderWithAuth. */
import type { StartSignInOptions } from "@shoojs/react";
import { createShooConvexAuth } from "@shoojs/react";

type ShooConvexAuth = ReturnType<typeof createShooConvexAuth>;

let shooConvexAuth: ShooConvexAuth | null = null;

function getShooConvexAuth(): ShooConvexAuth {
  if (!shooConvexAuth) {
    shooConvexAuth = createShooConvexAuth({
      callbackPath: "/auth/callback",
      requestPii: true,
    });
  }
  return shooConvexAuth;
}

/** Hook passed to ConvexProviderWithAuth. */
export function useAuth() {
  if (typeof window === "undefined") {
    return {
      isLoading: true,
      isAuthenticated: false,
      fetchAccessToken: async () => null,
    };
  }
  return getShooConvexAuth().useAuth();
}

/** Redirect to Shoo sign-in. */
export function signIn(opts?: StartSignInOptions) {
  return getShooConvexAuth().signIn(opts);
}

/** Clear identity and reload page. */
export function signOut() {
  return getShooConvexAuth().signOut();
}
