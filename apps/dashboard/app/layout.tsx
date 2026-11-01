import { ConvexClientProvider } from "@/app/components/ConvexClientProvider";
import { currentSession, selfHosted } from "@/app/lib/selfHostSession";
import type { InitialSession } from "@/app/lib/session";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { Metadata } from "next";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { headers } from "next/headers";
import { prefetchDNS } from "react-dom";
import "./globals.css";

export const metadata: Metadata = {
  title: "Broods Dashboard",
  description: "",
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.JSX.Element> {
  const initialSession = await initialSessionFromRequest();
  // DNS only, not preconnect: a WebSocket never reuses a pooled connection.
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl) prefetchDNS(convexUrl);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <NuqsAdapter>
          <ConvexClientProvider initialSession={initialSession}>
            {children}
          </ConvexClientProvider>
        </NuqsAdapter>
      </body>
    </html>
  );
}

async function initialSessionFromRequest(): Promise<InitialSession> {
  if (selfHosted) {
    return { kind: "selfHost", session: await currentSession() };
  }
  // The not-found page of an asset path the proxy matcher skips renders here with no session.
  if (!(await headers()).has("x-workos-middleware")) {
    return { initialAuth: { user: null }, kind: "workos" };
  }
  // The token stays out of the HTML: the proxy's `eagerAuth` cookie carries it.
  const { accessToken: _accessToken, ...initialAuth } = await withAuth();

  return { initialAuth: initialAuth, kind: "workos" };
}
