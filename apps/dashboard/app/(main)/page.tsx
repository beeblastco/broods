"use client";

/** Redirects authenticated users straight to the default workspace canvas. */
import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** Home route that ensures a default workspace exists and opens the canvas. */
export default function HomePage() {
    const router = useRouter();
    const getOrCreateOrg = useMutation(api.org.getOrCreate);
    const getOrCreateDefault = useMutation(api.project.getOrCreateDefault);
    const currentUser = useQuery(api.user.getCurrent);
    const hasStarted = useRef(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!currentUser) return;
        if (hasStarted.current) return;

        hasStarted.current = true;

        getOrCreateOrg({})
            .then(() => getOrCreateDefault({}))
            .then((projectId) => {
                router.replace(`/${projectId}`);
            })
            .catch((err) => {
                console.error("Failed to open workspace canvas:", err);
                setError(err instanceof Error ? err.message : "Failed to open canvas. Please refresh.");
                hasStarted.current = false;
            });
    }, [currentUser, getOrCreateOrg, getOrCreateDefault, router]);

    return (
        <div className="flex h-full items-center justify-center">
            {error ? (
                <div className="text-center">
                    <p className="text-sm text-destructive">{error}</p>
                    <button
                        className="mt-2 text-xs text-muted-foreground underline cursor-pointer"
                        onClick={() => {
                            hasStarted.current = false;
                            setError(null);
                        }}
                    >
                        Retry
                    </button>
                </div>
            ) : (
                <p className="text-sm text-muted-foreground">Opening canvas...</p>
            )}
        </div>
    );
}
