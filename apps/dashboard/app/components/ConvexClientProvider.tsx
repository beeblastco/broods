"use client";

import {
  AuthKitProvider,
  useAccessToken,
  useAuth as useAuthKit,
} from "@workos-inc/authkit-nextjs/components";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import type { ComponentProps, ReactNode } from "react";
import { useCallback } from "react";

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
 * Wraps the app with theme, auth, and Convex providers. `initialAuth` is the
 * session the root layout resolved on the server; with it AuthKit mounts
 * signed in and skips its server action on load.
 */
export function ConvexClientProvider({
  children,
  initialAuth,
}: {
  children: ReactNode;
  initialAuth: ComponentProps<typeof AuthKitProvider>["initialAuth"];
}): React.JSX.Element {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <AuthKitProvider initialAuth={initialAuth}>
        <ConvexProviderWithAuth client={convex} useAuth={useAuthAdapter}>
          {children}
        </ConvexProviderWithAuth>
      </AuthKitProvider>
    </ThemeProvider>
  );
}

/** Adapts WorkOS AuthKit authentication to the shape required by ConvexProviderWithAuth. */
function useAuthAdapter(): ConvexAuthAdapter {
  const { user, loading: isLoading } = useAuthKit();
  const { getAccessToken, refresh } = useAccessToken();

  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken,
    }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
      if (!user) {
        return null;
      }

      try {
        if (forceRefreshToken) {
          return (await refresh()) ?? null;
        }

        return (await getAccessToken()) ?? null;
      } catch (error) {
        console.error("Failed to get access token:", error);

        return null;
      }
    },
    [user, refresh, getAccessToken],
  );

  return {
    isLoading: isLoading ?? false,
    isAuthenticated: !!user,
    fetchAccessToken: fetchAccessToken,
  };
}
