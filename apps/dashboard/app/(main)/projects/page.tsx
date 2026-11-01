"use client";

import { useSignedIn } from "@/app/hooks/useSignedIn";
import { CreateProjectDialog } from "@/app/components/CreateProjectDialog";
import { ProjectCard } from "@/app/components/ProjectCard";
import { Button } from "@/app/components/ui/button";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import { applyProjectRename } from "@/app/lib/projectOptimistic";
import { api } from "@broods/convex/_generated/api";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Folder, Plus } from "lucide-react";
import { useState } from "react";

export default function ProjectsPage(): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const projects = useQuery(api.project.list, useSignedIn() ? {} : "skip") as
    | Doc<"projects">[]
    | undefined;
  const rename = useMutation(api.project.update).withOptimisticUpdate(
    applyProjectRename,
  );
  const [dialogOpen, setDialogOpen] = useState(false);

  if (projects === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading projects…</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Projects</h1>
            <p className="text-sm text-muted-foreground">
              Select a project to open, or create a new one.
            </p>
          </div>
          {canWrite && (
            <Button
              className="cursor-pointer"
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="size-4" />
              New Project
            </Button>
          )}
        </div>

        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border py-20 text-center">
            <Folder className="size-8 text-muted-foreground" />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-foreground">
                No projects yet
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                A project holds your agents, stages, and project keys.
              </p>
            </div>
            {canWrite && (
              <Button
                className="cursor-pointer"
                onClick={() => setDialogOpen(true)}
              >
                <Plus className="size-4" />
                Create your first project
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard
                key={project._id}
                name={project.name}
                description={project.description}
                href={`/${project._id}`}
                canWrite={canWrite}
                // The update clears a description it is not handed.
                onRename={(name) =>
                  rename({
                    description: project.description,
                    name: name,
                    projectId: project._id,
                  })
                }
              />
            ))}
          </div>
        )}
      </div>

      <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
