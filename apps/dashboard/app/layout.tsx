import { ConvexClientProvider } from "@/app/components/ConvexClientProvider";
import {
  SESSION_COOKIE,
  selfHosted,
  sessionUser,
} from "@/app/lib/selfHostSession";
import type { InitialSession } from "@/app/lib/session";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
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
 * stack reads its own session cookie instead.
 */
async function initialSessionFromRequest(): Promise<InitialSession> {
  if (selfHosted) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;

    return { kind: "selfHost", user: await sessionUser(token) };
  }
  if (!(await headers()).has("x-workos-middleware")) {
    return { initialAuth: { user: null }, kind: "workos" };
  }
  const { accessToken: _accessToken, ...initialAuth } = await withAuth();

  return { initialAuth: initialAuth, kind: "workos" };
}
