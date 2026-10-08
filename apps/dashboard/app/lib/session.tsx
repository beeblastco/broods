"use client";

import {
  AuthKitProvider,
  useAccessToken,
  useAuth as useAuthKit,
} from "@workos-inc/authkit-nextjs/components";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo } from "react";

export interface SessionUser {
  email: string;
  firstName: string | null;
  id: string;
  lastName: string | null;
  profilePictureUrl: string | null;
}

/**
 * The signed-in user, from WorkOS or a self-hosted stack's admin key. Shaped
 * so `ConvexProviderWithAuth` takes `useSession` as its `useAuth` directly.
 */
interface Session {
  /** A token Convex accepts, or null when signed out. */
  fetchAccessToken: (options: {
    forceRefreshToken: boolean;
  }) => Promise<string | null>;
  isAuthenticated: boolean;
  isLoading: boolean;
  signOut: () => void;
  user: SessionUser | null;
}

/** Which sign-in the root layout resolved: WorkOS AuthKit, or the self-hosted admin. */
export type InitialSession =
  | {
      initialAuth: ComponentProps<typeof AuthKitProvider>["initialAuth"];
      kind: "workos";
    }
  | {
      kind: "selfHost";
      session: { token: string; user: SessionUser } | null;
    };

const SessionContext = createContext<Session | null>(null);

/** Provides the session for `initial`'s kind to `useSession`. */
export function SessionProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial: InitialSession;
}): React.JSX.Element {
  if (initial.kind === "selfHost") {
    return (
      <SelfHostSession session={initial.session}>{children}</SelfHostSession>
    );
  }

  return (
    <AuthKitProvider initialAuth={initial.initialAuth}>
      <WorkOSSession>{children}</WorkOSSession>
    </AuthKitProvider>
  );
}

/** The session `SessionProvider` holds; the app reads the user, Convex the token. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession needs a SessionProvider");

  return session;
}

// The layout hands over the token it verified, so Convex authenticates with
// no round trip. It lives as long as the cookie, so a forced refresh means the
// session is over: null signs the app out.
function SelfHostSession({
  children,
  session,
}: {
  children: ReactNode;
  session: { token: string; user: SessionUser } | null;
}): React.JSX.Element {
  const value = useMemo(
    (): Session => ({
      fetchAccessToken: async ({
        forceRefreshToken,
      }): Promise<string | null> =>
        forceRefreshToken ? null : (session?.token ?? null),
      isAuthenticated: session !== null,
      isLoading: false,
      signOut: (): void => void signOutSelfHost(),
      user: session?.user ?? null,
    }),
    [session],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

// A full page load after the cookie is gone, so no signed-in state survives.
async function signOutSelfHost(): Promise<void> {
  await fetch("/auth/session", { method: "DELETE" });
  window.location.assign("/auth/key");
}

// AuthKit's user and access token, under AuthKitProvider, as a Session.
function WorkOSSession({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const { loading, signOut, user } = useAuthKit();
  const { getAccessToken, refresh } = useAccessToken();
  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken,
    }: {
      forceRefreshToken: boolean;
    }): Promise<string | null> => {
      if (!user) return null;
      try {
        return (
          (forceRefreshToken ? await refresh() : await getAccessToken()) ?? null
        );
      } catch (error) {
        console.error("Failed to get access token:", error);

        return null;
      }
    },
    [getAccessToken, refresh, user],
  );
  const value = useMemo(
    (): Session => ({
      fetchAccessToken: fetchAccessToken,
      isAuthenticated: !!user,
      isLoading: loading ?? false,
      signOut: (): void => void signOut(),
      user: user,
    }),
    [fetchAccessToken, loading, signOut, user],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}
