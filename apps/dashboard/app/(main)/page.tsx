"use client";

/** Projects dashboard displaying all user projects as interactive cards. */
import { CreateProjectDialog } from "@/app/components/CreateProjectDialog";
import { ProjectCard } from "@/app/components/ProjectCard";
import { Button } from "@/app/components/ui/button";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useState } from "react";

/** Main projects dashboard page. */
export default function ProjectsDashboard() {
    const projects = useQuery(api.project.listWithPreview);
    const [createOpen, setCreateOpen] = useState(false);

    if (projects === undefined) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            {/* Sticky title + action bar */}
            <div className="shrink-0 px-6 py-4">
                <div className="mx-auto flex max-w-5xl items-center justify-between">
                    <div>
                        <h1 className="text-lg font-semibold text-foreground">Projects</h1>
                        <p className="text-sm text-muted-foreground">
                            {projects.length} project{projects.length !== 1 ? "s" : ""}
                        </p>
                    </div>

                    <Button onClick={() => setCreateOpen(true)} size="sm">
                        <Plus className="size-4" />
                        New project
                    </Button>
                </div>
            </div>

            {/* Scrollable project grid */}
            <div className="flex-1 overflow-auto p-6">
                <div className="mx-auto max-w-5xl">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {projects.map((project) => (
                            <ProjectCard
                                key={project._id}
                                name={project.name}
                                canvas={project.canvas}
                                projectId={project._id}
                                deployedAgentCount={project.deployedAgentCount}
                            />
                        ))}
                    </div>
                </div>
            </div>

            <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
        </div>
    );
}
