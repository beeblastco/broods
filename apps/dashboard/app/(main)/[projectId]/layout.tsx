"use client";

import { StatusPage } from "@/app/components/StatusPage";
import { Button } from "@/app/components/ui/button";
import { useSignedIn } from "@/app/hooks/useSignedIn";
import { projectOrgGate } from "@/app/lib/projectOrg";
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
  const project = useQuery(api.dashboardReads.projectById, {
    projectId: projectId,
  });
  const active = useQuery(
    api.dashboardReads.activeOrg,
    useSignedIn() ? {} : "skip",
  );
  const setActive = useMutation(api.org.orgs.setActive);
  const [opened, setOpened] = useState<{
    landed: boolean;
    projectId: Id<"projects">;
    refused: Id<"orgs"> | null;
  }>({ landed: false, projectId: projectId, refused: null });
  const fresh = opened.projectId !== projectId;
  const landed =
    (!fresh && opened.landed) ||
    (project?.orgId !== undefined && project.orgId === active?._id);
  const refused = fresh ? null : opened.refused;
  if (fresh || landed !== opened.landed) {
    setOpened({ landed: landed, projectId: projectId, refused: refused });
  }
  const gate =
    project && active !== undefined
      ? projectOrgGate({
          activeOrg: active?._id ?? null,
          landed: landed,
          projectOrg: project.orgId,
          refused: refused,
        })
      : null;
  const switchTo = gate?.switchTo ?? null;

  // The pages act on the active org: switch on open, and when this tab is back in focus.
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- the active org is the user's Convex row
  useEffect(() => {
    if (!switchTo) return;
    const switchOrg = (): void => {
      void setActive({ orgId: switchTo }).catch((): void =>
        setOpened((prev) =>
          prev.projectId === projectId ? { ...prev, refused: switchTo } : prev,
        ),
      );
    };
    if (!landed) switchOrg();
    window.addEventListener("focus", switchOrg);

    return () => window.removeEventListener("focus", switchOrg);
  }, [landed, projectId, setActive, switchTo]);

  if (gate?.show === "wait") return null;
  if (project !== null && gate?.show !== "refused") return children;

  return (
    <StatusPage
      title="Project not found"
      description="It was deleted, or you are not a member of its org."
    >
      {project && (
        <Button
          onClick={() => window.location.reload()}
          className="cursor-pointer"
        >
          Reload
        </Button>
      )}
      <Button
        variant={project ? "outline" : "default"}
        nativeButton={false}
        render={<Link href="/projects" />}
        className="cursor-pointer"
      >
        Back to projects
      </Button>
    </StatusPage>
  );
}
