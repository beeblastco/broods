import { ConvexClientProvider } from "@/app/components/ConvexClientProvider";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "BeeBlast Dashboard",
    description: "",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body className="antialiased">
                <ConvexClientProvider>{children}</ConvexClientProvider>
            </body>
        </html>
    );
}
