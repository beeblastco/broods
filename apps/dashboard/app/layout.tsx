import { ConvexClientProvider } from "@/app/components/ConvexClientProvider";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ComponentProps } from "react";
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
  const initialAuth = await initialAuthFromRequest();
  // The Convex socket opens only once the JS runs; resolving its host while
  // the HTML streams takes the DNS lookup off a cold load. Not preconnect:
  // browsers open a WebSocket on its own connection, not a pooled one.
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl) prefetchDNS(convexUrl);

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ConvexClientProvider initialAuth={initialAuth}>
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
 * path the proxy matcher skips renders through this layout too.
 */
async function initialAuthFromRequest(): Promise<
  ComponentProps<typeof ConvexClientProvider>["initialAuth"]
> {
  if (!(await headers()).has("x-workos-middleware")) return { user: null };
  const { accessToken: _accessToken, ...initialAuth } = await withAuth();

  return initialAuth;
}
