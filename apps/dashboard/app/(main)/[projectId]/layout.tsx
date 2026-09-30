"use client";

import NotFound from "@/app/not-found";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { use } from "react";

/**
 * Guards every project route. A well-formed id the caller cannot read (deleted,
 * or another org's) lists no stages, since every project is created with its
 * default stage, so the page under the header becomes the not-found state
 * instead of loading forever. Same query and args as `useStage`, so it shares
 * that subscription.
 */
export default function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}): React.JSX.Element {
  const { projectId } = use(params);
  const stages = useQuery(api.stage.list, {
    projectId: projectId as Id<"projects">,
  });

  return stages?.length === 0 ? <NotFound /> : <>{children}</>;
}
