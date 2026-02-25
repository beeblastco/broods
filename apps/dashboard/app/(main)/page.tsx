"use client";

/** Redirects to the first project when landing on the root route. */
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/convex/_generated/api";

export default function RootRedirect() {
    const projects = useQuery(api.project.list);
    const router = useRouter();

    useEffect(() => {
        if (projects && projects.length > 0) {
            router.replace(`/${projects[0]._id}`);
        }
    }, [projects, router]);

    return null;
}
