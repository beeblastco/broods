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
        <html lang="en" className="dark" >
            <body className="antialiased" > {children} </body>
        </html>
    );
}