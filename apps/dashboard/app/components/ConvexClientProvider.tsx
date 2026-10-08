"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
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
        <ConvexProviderWithAuth client={convex} useAuth={useSession}>
          {children}
        </ConvexProviderWithAuth>
      </SessionProvider>
    </ThemeProvider>
  );
}
