"use client";

import { useShooAuth } from "@shoojs/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Protected layout that redirects unauthenticated users to /login. */
export default function MainLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const { identity, loading } = useShooAuth();
    const router = useRouter();

    useEffect(() => {
        if (!loading && !identity.userId) {
            router.replace("/login");
        }
    }, [loading, identity.userId, router]);

    if (loading) {
        return (
            <div className="flex h-screen w-screen items-center justify-center bg-[#0a0a0a]">
                <p className="text-sm text-white/50">Loading...</p>
            </div>
        );
    }

    if (!identity.userId) {
        return null;
    }

    return <>{children}</>;
}
