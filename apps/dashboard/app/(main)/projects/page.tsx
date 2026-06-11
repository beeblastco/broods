"use client";

/** Project gallery: lists every project in the active org and lets the user open or create one. */
import { CreateProjectDialog } from "@/app/components/CreateProjectDialog";
import { Button } from "@/app/components/ui/button";
import { FULL_ROUTE_PREFETCH } from "@/app/lib/prefetch";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { Folder, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

/** Full-page grid of the user's projects with create and empty states. */
export default function ProjectsPage() {
    const projects = useQuery(api.project.list) as Doc<"projects">[] | undefined;
    const router = useRouter();
    const [dialogOpen, setDialogOpen] = useState(false);

    const openProject = useCallback((id: string) => router.push(`/${id}`), [router]);
    const prefetchProject = useCallback(
        (id: string) => router.prefetch(`/${id}`, FULL_ROUTE_PREFETCH),
        [router],
    );

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
                    <Button className="cursor-pointer" onClick={() => setDialogOpen(true)}>
                        <Plus className="size-4" />
                        New Project
                    </Button>
                </div>

                {projects.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border py-20 text-center">
                        <Folder className="size-8 text-muted-foreground/50" />
                        <div className="flex flex-col gap-1">
                            <p className="text-sm font-medium text-foreground">No projects yet</p>
                            <p className="max-w-sm text-sm text-muted-foreground">
                                Create a project to start building and deploying AI agents.
                            </p>
                        </div>
                        <Button className="cursor-pointer" onClick={() => setDialogOpen(true)}>
                            <Plus className="size-4" />
                            Create your first project
                        </Button>
                    </div>
                ) : (
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {projects.map((project) => (
                            <button
                                key={project._id}
                                type="button"
                                onClick={() => openProject(project._id)}
                                onMouseEnter={() => prefetchProject(project._id)}
                                onFocus={() => prefetchProject(project._id)}
                                className="flex cursor-pointer flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left transition-all hover:ring-2 hover:ring-primary/50"
                            >
                                <div className="flex w-full items-center gap-2">
                                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                                    <span className="truncate text-sm font-medium text-foreground">
                                        {project.name}
                                    </span>
                                </div>
                                <p className="line-clamp-2 text-xs text-muted-foreground">
                                    {project.description || "No description"}
                                </p>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <CreateProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
        </div>
    );
}
