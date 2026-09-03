"use client";

/** Dropdown selector for switching between user projects with an option to create new ones. */
import { CreateProjectDialog } from "@/app/components/CreateProjectDialog";
import { Button } from "@/app/components/ui/button";
import { useOrgRole } from "@/app/hooks/useOrgRole";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Skeleton } from "@/app/components/ui/skeleton";
import { FULL_ROUTE_PREFETCH } from "@/app/lib/prefetch";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useConvexAuth, useQuery } from "convex/react";
import { ChevronDown, Folder, Plus } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/** Dropdown to list, switch, and create projects. */
export function ProjectSelector(): React.JSX.Element {
  const { canWrite } = useOrgRole();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const queryArgs = !isLoading && isAuthenticated ? {} : "skip";
  const projects = useQuery(api.project.list, queryArgs) as
    | Doc<"projects">[]
    | undefined;
  const currentUser = useQuery(api.user.getCurrent, queryArgs);
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

  // The header divider next to this is always painted, so rendering nothing
  // here collapses the row and shifts it back once the query lands.
  if (projects === undefined) {
    return <Skeleton className="h-4 w-24 bg-muted" />;
  }

  const currentProjectId = params.projectId;
  const selectedProject = projects.find(
    (p: Doc<"projects">) => p._id === currentProjectId,
  );
  // The trigger states what is true right now — never another project's name.
  const displayName = selectedProject?.name ?? "Select project";
  const userName = currentUser?.name?.split(" ")[0] ?? "";
  const projectsLabel = userName ? `${userName}'s projects` : "Projects";

  // An org with no projects has nothing to pick from: skip the menu and put the
  // create action itself in the header, one click from the same dialog.
  if (projects.length === 0) {
    if (!canWrite) return <></>;

    return (
      <>
        <Button
          variant="ghost"
          className="h-auto select-none gap-1.5 px-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground active:bg-accent/80 focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none cursor-pointer"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="size-3.5" />
          New Project
        </Button>

        <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      </>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="h-auto select-none gap-1.5 px-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground active:bg-accent/80 data-popup-open:bg-accent data-popup-open:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none cursor-pointer"
            />
          }
        >
          <span className="truncate block">{displayName}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          sideOffset={8}
          className="flex max-h-[min(24rem,var(--available-height))] w-72 flex-col overflow-hidden"
        >
          <DropdownMenuGroup className="flex min-h-0 flex-1 flex-col">
            <DropdownMenuLabel>{projectsLabel}</DropdownMenuLabel>
            <DropdownMenuSeparator />

            <div className="min-h-0 flex-1 overflow-y-auto">
              {projects.map((project: Doc<"projects">) => (
                <DropdownMenuItem
                  key={project._id}
                  onClick={() => router.push(`/${project._id}`)}
                  onMouseEnter={() => prefetchProject(project._id)}
                  onFocus={() => prefetchProject(project._id)}
                  className={cn(
                    "cursor-pointer",
                    project._id === currentProjectId
                      ? "bg-accent text-accent-foreground"
                      : "",
                  )}
                >
                  <Folder className="size-4" />
                  <span className="truncate max-w-60 block">
                    {project.name}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          </DropdownMenuGroup>

          {canWrite && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={() => setDialogOpen(true)}
              >
                <Plus className="size-4" />
                New Project
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
