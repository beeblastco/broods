"use client";

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import { useSignedIn } from "@/app/hooks/useSignedIn";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

// An id the caller cannot read (deleted, another org's) resolves to null: not found.
export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  const { projectId } = useParams<{ projectId: Id<"projects"> }>();
  const project = useQuery(api.project.getById, { projectId: projectId });
  const active = useQuery(api.org.orgs.getActive, useSignedIn() ? {} : "skip");
  const setActive = useMutation(api.org.orgs.setActive);
  // The pages act on the active org, so opening another org's project switches to that org once.
  const [opened, setOpened] = useState<{
    foreign: Id<"orgs"> | null;
    projectId: Id<"projects">;
  } | null>(null);
  if (project && active && opened?.projectId !== projectId) {
    setOpened({
      foreign: project.orgId === active._id ? null : project.orgId,
      projectId: projectId,
    });
  }
  const foreign = opened?.projectId === projectId ? opened.foreign : null;
  const [refused, setRefused] = useState<Id<"orgs"> | null>(null);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- the active org is the user's Convex row
  useEffect(() => {
    if (!foreign) return;
    void setActive({ orgId: foreign }).catch((): void => setRefused(foreign));
  }, [foreign, setActive]);

  if (project !== null && (!foreign || refused !== foreign)) {
    return foreign && active?._id !== foreign ? null : children;
  }

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
