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
    // Off, the client fetches a fresh token at once (a server action on every cold load)
    // and re-authenticates, which re-runs every subscribed query.
    initialAuthTokenReuse: true,
  },
);

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
