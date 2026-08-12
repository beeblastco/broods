"use client";

/** Project name switcher and (when on a project page) stage selector in the header. */
import { StageSelector } from "@/app/components/StageSelector";
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
          <StageSelector />
        </>
      )}
    </>
  );
}
