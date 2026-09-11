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
