"use client";

/** Handles the Shoo OAuth callback redirect and navigates to / on success. */
import { useConvexAuth } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function ShooCallback() {
    const { isLoading, isAuthenticated } = useConvexAuth();
    const router = useRouter();

    useEffect(() => {
        if (!isLoading && isAuthenticated) {
            router.replace("/");
        }
    }, [isLoading, isAuthenticated, router]);

    return <p>Signing in...</p>;
}
