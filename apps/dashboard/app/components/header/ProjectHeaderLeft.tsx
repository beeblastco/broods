"use client";

import { StageSelector } from "@/app/components/StageSelector";
import { ProjectSelector } from "@/app/components/ProjectSelector";
import { useParams } from "next/navigation";

export function ProjectHeaderLeft(): React.JSX.Element {
  const params = useParams<{ projectId?: string }>();
  const hasProject = Boolean(params.projectId);

  return (
    <>
      <div className="h-4 w-px shrink-0 bg-border" />
      <ProjectSelector />
      {hasProject && (
        <>
          <div className="h-4 w-px shrink-0 bg-border" />
          <StageSelector />
        </>
      )}
    </>
  );
}
