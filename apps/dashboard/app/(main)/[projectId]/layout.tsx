"use client";

import NotFound from "@/app/not-found";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { useParams } from "next/navigation";

/**
 * Guards every project route. A well-formed id the caller cannot read (deleted,
 * or another org's) lists no stages, since every project is created with its
 * default stage, so the page under the header becomes the not-found state
 * instead of loading forever. Same query and args as `useStage`, so it shares
 * that subscription.
 */
export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { projectId } = useParams<{ projectId: Id<"projects"> }>();
  const stages = useQuery(api.stage.list, { projectId: projectId });

  return stages?.length === 0 ? <NotFound /> : <>{children}</>;
}
