"use client";

/** Gates content behind project creation — shows onboarding when user has no projects. */
import type { ReactNode } from "react";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Plus } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";

interface OnboardingGateProps {
    children: ReactNode;
}

/** Shows a create-project prompt when the user has zero projects, otherwise renders children. */
export function OnboardingGate({ children }: OnboardingGateProps) {
    const projects = useQuery(api.project.list);
    const createProject = useMutation(api.project.create);
    const router = useRouter();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [newName, setNewName] = useState("");
    const [isCreating, setIsCreating] = useState(false);

    // Still loading
    if (projects === undefined) {
        return (
            <div className="flex flex-1 items-center justify-center">
                <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
        );
    }

    // User has projects — render normal content
    if (projects.length > 0) {
        return <>{children}</>;
    }

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

    // No projects — show onboarding
    return (
        <>
            <div className="flex flex-1 flex-col items-center justify-center gap-6">
                <div className="flex flex-col items-center gap-2 text-center">
                    <h2 className="text-xl font-semibold text-foreground">
                        Welcome to Clonee
                    </h2>
                    <p className="max-w-sm text-sm text-muted-foreground">
                        Create your first project to start building and deploying AI agents.
                    </p>
                </div>
                <Button onClick={() => setDialogOpen(true)} size="lg">
                    <Plus className="size-4" />
                    Create your first project
                </Button>
            </div>

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Create Project</DialogTitle>
                        <DialogDescription>
                            Give your first project a name to get started.
                        </DialogDescription>
                    </DialogHeader>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            handleCreate();
                        }}
                    >
                        <div className="grid gap-3 py-4">
                            <Label htmlFor="onboarding-project-name">Project name</Label>
                            <Input
                                id="onboarding-project-name"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="My first project"
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
