"use client";

/** Home route that ensures the caller has an org, then opens their default project (auto-created on first login). */
import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** Routes authenticated users to their most recent project, creating one on first login. */
export default function HomePage() {
    const router = useRouter();
    const getOrCreateOrg = useMutation(api.org.getOrCreate);
    const getOrCreateDefault = useMutation(api.project.getOrCreateDefault);
    const currentUser = useQuery(api.user.getCurrent);
    const bootstrapped = useRef(false);
    const [error, setError] = useState<string | null>(null);

    // Ensure the caller has an org, then open or create the default project.
    useEffect(() => {
        if (!currentUser || bootstrapped.current) return;

        bootstrapped.current = true;
        (async () => {
            try {
                await getOrCreateOrg({});
                const projectId = await getOrCreateDefault({});
                router.replace(projectId ? `/${projectId}` : "/projects");
            } catch (err) {
                console.error("Failed to open workspace:", err);
                setError(err instanceof Error ? err.message : "Failed to open workspace. Please refresh.");
                bootstrapped.current = false;
            }
        })();
    }, [currentUser, getOrCreateOrg, getOrCreateDefault, router]);

    return (
        <div className="flex h-full w-full items-center justify-center bg-background">
            {error ? (
                <div className="flex flex-col items-center gap-3 text-center">
                    <p className="text-sm text-destructive">{error}</p>
                    <button
                        className="text-xs text-muted-foreground underline cursor-pointer"
                        onClick={() => {
                            bootstrapped.current = false;
                            setError(null);
                        }}
                    >
                        Retry
                    </button>
                </div>
            ) : (
                <div className="flex flex-col items-center gap-3">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
                    <p className="text-sm text-muted-foreground">Setting up your workspace…</p>
                </div>
            )}
        </div>
    );
}
