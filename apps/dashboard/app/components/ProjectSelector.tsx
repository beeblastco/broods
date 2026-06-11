"use client";

/** Dropdown selector for switching between user projects with an option to create new ones. */
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { ChevronDown, Plus, Folder } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Button } from "@/app/components/ui/button";
import { CreateProjectDialog } from "@/app/components/CreateProjectDialog";
import { FULL_ROUTE_PREFETCH } from "@/app/lib/prefetch";

/** Dropdown to list, switch, and create projects. */
export function ProjectSelector() {
  const projects = useQuery(api.project.list) as Doc<"projects">[] | undefined;
  const currentUser = useQuery(api.user.getCurrent);
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const prefetchProject = useCallback(
    (id: string) => router.prefetch(`/${id}`, FULL_ROUTE_PREFETCH),
    [router],
  );

  useEffect(() => {
    if (projects === undefined || projects.length === 0) return;

    const warmTopProjects = () => {
      for (const project of projects.slice(0, 3)) {
        prefetchProject(project._id);
      }
    };

    if (typeof window !== "undefined" && window.requestIdleCallback) {
      const idleId = window.requestIdleCallback(warmTopProjects, {
        timeout: 1500,
      });

      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = window.setTimeout(warmTopProjects, 120);

    return () => window.clearTimeout(timeoutId);
  }, [projects, prefetchProject]);

  // Hide selector entirely when loading or the user has no projects yet.
  if (projects === undefined || projects.length === 0) {
    return null;
  }

  const currentProjectId = params.projectId;
  const selectedProject = projects.find(
    (p: Doc<"projects">) => p._id === currentProjectId,
  );
  const displayName =
    selectedProject?.name ??
    (currentProjectId ? projects[0]?.name : "Projects");
  const userName = currentUser?.name?.split(" ")[0] ?? "";
  const projectsLabel = userName ? `${userName}'s projects` : "Projects";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto select-none gap-1.5 px-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground active:bg-accent/80 data-[state=open]:bg-accent data-[state=open]:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none cursor-pointer"
          >
            {displayName}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" sideOffset={8} className="w-56">
          <DropdownMenuLabel>{projectsLabel}</DropdownMenuLabel>
          <DropdownMenuSeparator />

          {projects.map((project: Doc<"projects">) => (
            <DropdownMenuItem
              key={project._id}
              onClick={() => router.push(`/${project._id}`)}
              onMouseEnter={() => prefetchProject(project._id)}
              onFocus={() => prefetchProject(project._id)}
              className={
                project._id === currentProjectId
                  ? "bg-accent text-accent-foreground"
                  : ""
              }
            >
              <Folder className="size-4" />
              {project.name}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDialogOpen(true)}>
            <Plus className="size-4" />
            New Project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
