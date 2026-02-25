import { ConvexClientProvider } from "@/app/components/ConvexClientProvider";
import { ThemeProvider } from "next-themes";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "Clonee",
    description: "Fast deploy your agent any time, anywhere",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body className="antialiased">
                <ThemeProvider
                    attribute="class"
                    defaultTheme="dark"
                    enableSystem={false}
                >
                    <ConvexClientProvider>{children}</ConvexClientProvider>
                </ThemeProvider>
            </body>
        </html>
    );
}
