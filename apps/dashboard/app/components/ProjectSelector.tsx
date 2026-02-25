"use client";

/** Dropdown selector for switching between user projects with an option to create new ones. */
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
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
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/app/components/ui/dialog";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";

/** Dropdown to list, switch, and create projects. */
export function ProjectSelector() {
    const projects = useQuery(api.project.list);
    const currentUser = useQuery(api.user.getCurrent);
    const createProject = useMutation(api.project.create);
    const router = useRouter();
    const params = useParams<{ projectId?: string }>();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [newName, setNewName] = useState("");
    const [isCreating, setIsCreating] = useState(false);

    // Hide selector entirely when loading or user has no projects (OnboardingGate handles that)
    if (projects === undefined || projects.length === 0) {
        return null;
    }

    const currentProjectId = params.projectId;
    const selectedProject = projects.find((p) => p._id === currentProjectId);
    const displayName = selectedProject?.name ?? projects[0]?.name;
    const userName = currentUser?.name?.split(" ")[0] ?? "";
    const projectsLabel = userName ? `${userName}'s projects` : "Projects";

    async function handleCreate() {
        if (!newName.trim()) return;
        setIsCreating(true);
        try {
            const id = await createProject({ name: newName.trim(), description: undefined });
            setDialogOpen(false);
            setNewName("");
            router.push(`/${id}`);
        } finally {
            setIsCreating(false);
        }
    }

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none data-[state=open]:bg-accent data-[state=open]:text-foreground">
                        {displayName}
                        <ChevronDown className="size-3.5 opacity-50" />
                    </button>
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

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Create Project</DialogTitle>
                        <DialogDescription>
                            Give your new project a name to get started.
                        </DialogDescription>
                    </DialogHeader>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            handleCreate();
                        }}
                    >
                        <div className="grid gap-3 py-4">
                            <Label htmlFor="project-name">Project name</Label>
                            <Input
                                id="project-name"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="My new project"
                                autoFocus
                            />
                        </div>
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => setDialogOpen(false)}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={!newName.trim() || isCreating}>
                                {isCreating ? "Creating..." : "Create"}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}
