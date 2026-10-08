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

/** What the app reads about the signed-in user, from WorkOS or a self-hosted stack's admin key. */
interface Session {
  /** A token Convex accepts, or null when signed out. */
  getAccessToken: (forceRefresh: boolean) => Promise<string | null>;
  loading: boolean;
  signOut: () => void;
  user: SessionUser | null;
}

/** Which sign-in the root layout resolved: WorkOS AuthKit, or the self-hosted admin. */
export type InitialSession =
  | {
      initialAuth: ComponentProps<typeof AuthKitProvider>["initialAuth"];
      kind: "workos";
    }
  | { kind: "selfHost"; user: SessionUser | null };

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
    return <SelfHostSession user={initial.user}>{children}</SelfHostSession>;
  }

  return (
    <AuthKitProvider initialAuth={initial.initialAuth}>
      <WorkOSSession>{children}</WorkOSSession>
    </AuthKitProvider>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession needs a SessionProvider");

  return session;
}

// The session cookie is httpOnly, so the client asks /auth/session for it.
function SelfHostSession({
  children,
  user,
}: {
  children: ReactNode;
  user: SessionUser | null;
}): React.JSX.Element {
  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const response = await fetch("/auth/session", { cache: "no-store" });
    if (!response.ok) return null;
    const { token }: { token: string | null } = await response.json();

    return token;
  }, []);
  const session = useMemo(
    (): Session => ({
      getAccessToken: getAccessToken,
      loading: false,
      signOut: (): void => void signOutSelfHost(),
      user: user,
    }),
    [getAccessToken, user],
  );

  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}

// A full page load after the cookie is gone, so no signed-in state survives.
async function signOutSelfHost(): Promise<void> {
  await fetch("/auth/session", { method: "DELETE" });
  window.location.assign("/auth/key");
}

function WorkOSSession({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const { loading, signOut, user } = useAuthKit();
  const { getAccessToken, refresh } = useAccessToken();
  const getToken = useCallback(
    async (forceRefresh: boolean): Promise<string | null> =>
      (forceRefresh ? await refresh() : await getAccessToken()) ?? null,
    [getAccessToken, refresh],
  );
  const session = useMemo(
    (): Session => ({
      getAccessToken: getToken,
      loading: loading ?? false,
      signOut: (): void => void signOut(),
      user: user,
    }),
    [getToken, loading, signOut, user],
  );

  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}
