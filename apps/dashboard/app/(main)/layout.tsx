"use client";

/** Protected layout that redirects unauthenticated users to /login and shows onboarding for new users. */
import { useConvexAuth } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { Header } from "@/app/components/Header";
import { OnboardingGate } from "@/app/components/OnboardingGate";

export default function MainLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const { isLoading, isAuthenticated } = useConvexAuth();
    const router = useRouter();
    const pathname = usePathname();
    const bypassOnboarding =
        pathname === "/account" || pathname.startsWith("/account/");

    useEffect(() => {
        if (!isLoading && !isAuthenticated) {
            router.replace("/login");
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
            {bypassOnboarding ? (
                <div className="flex-1 overflow-y-auto">{children}</div>
            ) : (
                <OnboardingGate>
                    <div className="flex-1 overflow-y-auto">{children}</div>
                </OnboardingGate>
            )}
        </div>
    );
}
