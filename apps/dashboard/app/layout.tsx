import { ConvexClientProvider } from "@/app/components/ConvexClientProvider";
import { withAuth } from "@workos-inc/authkit-nextjs";
import type { Metadata } from "next";
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
  // Resolved on the server so the client mounts already signed in, instead of
  // asking a server action who the user is. The token itself stays out of the
  // HTML: the proxy's `eagerAuth` cookie carries it to the browser.
  const { accessToken: _accessToken, ...initialAuth } = await withAuth();

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
