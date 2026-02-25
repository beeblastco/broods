"use client";

/** Gates content behind project creation — shows onboarding when user has no projects. */
import type { ReactNode } from "react";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Plus } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { CreateProjectDialog } from "@/app/components/CreateProjectDialog";

interface OnboardingGateProps {
    children: ReactNode;
}

/** Shows a create-project prompt when the user has zero projects, otherwise renders children. */
export function OnboardingGate({ children }: OnboardingGateProps) {
    const projects = useQuery(api.project.list);
    const [dialogOpen, setDialogOpen] = useState(false);

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

            <CreateProjectDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                description="Give your first project a name to get started."
            />
        </>
    );
}
