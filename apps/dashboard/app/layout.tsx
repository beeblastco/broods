import { ConvexClientProvider } from "@/app/components/ConvexClientProvider";
import { currentSession, selfHosted } from "@/app/lib/selfHostSession";
import type { InitialSession } from "@/app/lib/session";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { prefetchDNS } from "react-dom";
import "./globals.css";

export const metadata: Metadata = {
  title: "Broods Dashboard",
  description: "",
  // Everything past sign-in is behind auth; nothing here is for search engines.
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.JSX.Element> {
  const initialSession = await initialSessionFromRequest();
  // Resolve the Convex host while the HTML streams. Not preconnect: a WebSocket never reuses a pooled connection.
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl) prefetchDNS(convexUrl);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ConvexClientProvider initialSession={initialSession}>
          {children}
        </ConvexClientProvider>
      </body>
    </html>
  );
}

/**
 * Resolved on the server so the client mounts already signed in, instead of
 * asking a server action who the user is. The token itself stays out of the
 * HTML: the proxy's `eagerAuth` cookie carries it to the browser. Without the
 * proxy header there is no session to read: the not-found page for an asset
 * path the proxy matcher skips renders through this layout too. A self-hosted
 * stack reads its own session cookie, and hands the client the token so the
 * Convex client authenticates without a round trip.
 */
async function initialSessionFromRequest(): Promise<InitialSession> {
  if (selfHosted) {
    return { kind: "selfHost", session: await currentSession() };
  }
  if (!(await headers()).has("x-workos-middleware")) {
    return { initialAuth: { user: null }, kind: "workos" };
  }
  const { accessToken: _accessToken, ...initialAuth } = await withAuth();

  return { initialAuth: initialAuth, kind: "workos" };
}
