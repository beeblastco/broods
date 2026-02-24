"use client";

import { useShooAuth } from "@shoojs/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Handles the Shoo OAuth callback redirect and navigates to / on success. */
export default function ShooCallback() {
    const { identity, loading } = useShooAuth();
    const router = useRouter();

    useEffect(() => {
        if (!loading && identity.userId) {
            router.replace("/");
        }
    }, [loading, identity.userId, router]);

    return <p>Signing in...</p>;
}
