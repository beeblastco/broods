"use client";

/** Dropdown selector for switching between user projects with an option to create new ones. */
import { useState } from "react";
import { useQuery } from "convex/react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
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

/** Dropdown to list, switch, and create projects. */
export function ProjectSelector() {
    const projects = useQuery(api.project.list);
    const currentUser = useQuery(api.user.getCurrent);
    const router = useRouter();
    const params = useParams<{ projectId?: string }>();
    const [dialogOpen, setDialogOpen] = useState(false);

    // Hide selector entirely when loading or user has no projects (OnboardingGate handles that)
    if (projects === undefined || projects.length === 0) {
        return null;
    }

    const currentProjectId = params.projectId;
    const selectedProject = projects.find((p) => p._id === currentProjectId);
    const displayName = selectedProject?.name ?? projects[0]?.name;
    const userName = currentUser?.name?.split(" ")[0] ?? "";
    const projectsLabel = userName ? `${userName}'s projects` : "Projects";

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="h-auto gap-1.5 px-2 py-1 text-sm font-medium text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground">
                        {displayName}
                        <ChevronDown className="size-3.5 opacity-50" />
                    </Button>
                </DropdownMenuTrigger>

                <DropdownMenuContent align="start" sideOffset={8} className="w-56">
                    <DropdownMenuLabel>{projectsLabel}</DropdownMenuLabel>
                    <DropdownMenuSeparator />

                    {projects.map((project) => (
                        <DropdownMenuItem
                            key={project._id}
                            onClick={() => router.push(`/${project._id}`)}
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
