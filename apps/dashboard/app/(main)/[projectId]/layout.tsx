"use client";

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useParams } from "next/navigation";

/**
 * Guards every project route. A well-formed id the caller cannot read (deleted,
 * or another org's) resolves to no project, so the page under the header
 * becomes the not-found state instead of loading forever.
 */
export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { projectId } = useParams<{ projectId: Id<"projects"> }>();
  const project = useQuery(api.project.getById, { projectId: projectId });

  if (project !== null) return <>{children}</>;

  return (
    <StatusPage
      title="Project not found"
      description="It was deleted, or you are not a member of its org."
    >
      <Button
        nativeButton={false}
        render={<Link href="/projects" />}
        className="cursor-pointer"
      >
        Back to projects
      </Button>
    </StatusPage>
  );
}
