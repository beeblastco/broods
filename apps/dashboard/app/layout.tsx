import { ConvexClientProvider } from "@/app/components/ConvexClientProvider";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ComponentProps } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Broods Dashboard",
  description: "",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.JSX.Element> {
  const initialAuth = await initialAuthFromRequest();

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
 * HTML: the proxy's `eagerAuth` cookie carries it to the browser.
 *
 * `withAuth` throws when the proxy did not run, and the proxy matcher skips
 * asset-looking paths (`/missing.svg`), whose not-found page still renders
 * through this layout: without the header there is no session to read, so
 * answer signed out rather than 500.
 */
async function initialAuthFromRequest(): Promise<
  ComponentProps<typeof ConvexClientProvider>["initialAuth"]
> {
  if (!(await headers()).has("x-workos-middleware")) return { user: null };
  const { accessToken: _accessToken, ...initialAuth } = await withAuth();

  return initialAuth;
}
