"use client";

/** Protected layout that redirects unauthenticated users to /login. */
import { Header } from "@/app/components/Header";
import { useConvexAuth } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function MainLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const { isLoading, isAuthenticated } = useConvexAuth();
    const router = useRouter();

    useEffect(() => {
        if (!isLoading && !isAuthenticated) {
            router.replace("/auth/sign-in?returnTo=/");
        }
    }, [isLoading, isAuthenticated, router]);

    if (isLoading) {
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-background">
                <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    return (
        <div className="flex h-screen w-screen flex-col bg-background">
            <Header />
            <div className="flex-1 overflow-hidden">{children}</div>
        </div>
    );
}
