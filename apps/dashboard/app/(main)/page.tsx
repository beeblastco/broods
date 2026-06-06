"use client";

/** Redirects authenticated users straight to the default workspace canvas. */
import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/** Home route that ensures a default workspace exists and opens the canvas. */
export default function HomePage() {
    const router = useRouter();
    const getOrCreateOrg = useMutation(api.org.getOrCreate);
    const getOrCreateDefault = useMutation(api.project.getOrCreateDefault);
    const currentUser = useQuery(api.user.getCurrent);
    const hasStarted = useRef(false);

    useEffect(() => {
        if (!currentUser) {
            return;
        }

        if (hasStarted.current) {
            return;
        }

        hasStarted.current = true;

        getOrCreateOrg({})
            .then(() => getOrCreateDefault({}))
            .then((projectId) => {
                router.replace(`/${projectId}`);
            })
            .catch((error) => {
                console.error("Failed to open workspace canvas:", error);
                hasStarted.current = false;
            });
    }, [currentUser, getOrCreateOrg, getOrCreateDefault, router]);

    return (
        <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">Opening canvas...</p>
        </div>
    );
}
