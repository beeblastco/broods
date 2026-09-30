"use client";

import NotFound from "@/app/not-found";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
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

  return project === null ? <NotFound /> : <>{children}</>;
}
