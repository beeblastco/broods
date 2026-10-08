"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import type { ComponentProps, ReactNode } from "react";
import { useCallback } from "react";
import {
  SessionProvider,
  useSession,
  type InitialSession,
} from "@/app/lib/session";

const convex = new ConvexReactClient(
  process.env.NEXT_PUBLIC_CONVEX_URL as string,
  {
    // Keep the token the server just confirmed. Off, the client fetches a
    // fresh one at once (a server action on every cold load) and sends a
    // second Authenticate that re-runs every subscribed query.
    initialAuthTokenReuse: true,
  },
);

type ConvexAuthAdapter = ReturnType<
  NonNullable<ComponentProps<typeof ConvexProviderWithAuth>["useAuth"]>
>;

/**
 * Wraps the app with theme, session, and Convex providers. `initialSession`
 * is the session the root layout resolved on the server; with it the app
 * mounts signed in and skips an auth round trip on load.
 */
export function ConvexClientProvider({
  children,
  initialSession,
}: {
  children: ReactNode;
  initialSession: InitialSession;
}): React.JSX.Element {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <SessionProvider initial={initialSession}>
        <ConvexProviderWithAuth client={convex} useAuth={useAuthAdapter}>
          {children}
        </ConvexProviderWithAuth>
      </SessionProvider>
    </ThemeProvider>
  );
}

/** Adapts the session to the shape required by ConvexProviderWithAuth. */
function useAuthAdapter(): ConvexAuthAdapter {
  const { getAccessToken, loading, user } = useSession();

  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken,
    }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
      if (!user) {
        return null;
      }

      try {
        return await getAccessToken(forceRefreshToken ?? false);
      } catch (error) {
        console.error("Failed to get access token:", error);

        return null;
      }
    },
    [user, getAccessToken],
  );

  return {
    isLoading: loading,
    isAuthenticated: !!user,
    fetchAccessToken: fetchAccessToken,
  };
}
