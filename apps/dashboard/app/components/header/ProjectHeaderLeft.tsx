"use client";

import { EnvironmentSelector } from "@/app/components/EnvironmentSelector";
import { ProjectSelector } from "@/app/components/ProjectSelector";

/** Project-specific selectors shown on the left side of the header. */
export function ProjectHeaderLeft() {
    return (
        <>
            <div className="h-4 w-px bg-border" />
            <ProjectSelector />
            <div className="h-4 w-px bg-border" />
            <EnvironmentSelector />
        </>
    );
}
