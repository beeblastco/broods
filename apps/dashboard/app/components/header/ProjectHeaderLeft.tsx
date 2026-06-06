"use client";

/** Project name switcher and (when on a project page) environment selector in the header. */
import { EnvironmentSelector } from "@/app/components/EnvironmentSelector";
import { ProjectSelector } from "@/app/components/ProjectSelector";
import { useParams } from "next/navigation";

export function ProjectHeaderLeft() {
    const params = useParams<{ projectId?: string }>();
    const hasProject = Boolean(params.projectId);

    return (
        <>
            <div className="h-4 w-px bg-border" />
            <ProjectSelector />
            {hasProject && (
                <>
                    <div className="h-4 w-px bg-border" />
                    <EnvironmentSelector />
                </>
            )}
        </>
    );
}
