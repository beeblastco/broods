/** Shoo auth module wired for ConvexProviderWithAuth. */
import type { StartSignInOptions } from "@shoojs/react";
import { createShooConvexAuth } from "@shoojs/react";

let _auth: ReturnType<typeof createShooConvexAuth> | null = null;

function getAuth() {
  if (!_auth) {
    _auth = createShooConvexAuth({
      callbackPath: "/auth/callback",
      requestPii: true,
    });
  }

  return _auth;
}

/** Hook for ConvexProviderWithAuth — returns loading state during SSR. */
export function useAuth() {
  if (typeof window === "undefined") {
    return {
      isLoading: true,
      isAuthenticated: false,
      fetchAccessToken: async () => null,
    };
  }

  return getAuth().useAuth();
}

/** Redirect to Shoo sign-in. */
export function signIn(opts?: StartSignInOptions) {
  return getAuth().signIn(opts);
}

/** Clear identity and reload page. */
export function signOut() {
  return getAuth().signOut();
}
