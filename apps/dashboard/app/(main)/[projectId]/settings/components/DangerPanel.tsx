"use client";

/** Danger panel: permanently delete this project with a confirmation dialog. */
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
    /** Project to delete. */
    projectId: Id<"projects">;
}

export function DangerPanel({ projectId }: Props) {
    const project = useQuery(api.project.getById, { projectId: projectId });
    const removeProject = useMutation(api.project.remove);
    const router = useRouter();

    const [dialogOpen, setDialogOpen] = useState(false);
    const [confirmName, setConfirmName] = useState("");
    const [isDeleting, setIsDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const expectedPhrase = project?.name ?? "";
    const confirmed = confirmName.trim() === expectedPhrase;

    async function handleDelete() {
        if (!confirmed) return;
        setIsDeleting(true);
        setDeleteError(null);
        try {
            await removeProject({ projectId: projectId });
            router.replace("/");
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : "Failed to delete project.");
            setIsDeleting(false);
        }
    }

    return (
        <>
            <Section
                title="Delete Project"
                description="Permanently delete this project and all its data. This cannot be undone."
                danger
            >
                <div className="flex items-center justify-between gap-6">
                    <div>
                        <p className="text-sm font-medium text-foreground">Delete this project</p>
                        <p className="text-xs text-muted-foreground">
                            All environments, agent configs, canvas layouts, and variables will be permanently removed.
                        </p>
                    </div>
                    <Button
                        variant="destructive"
                        size="sm"
                        className="shrink-0 cursor-pointer"
                        onClick={() => {
                            setDeleteError(null);
                            setConfirmName("");
                            setDialogOpen(true);
                        }}
                    >
                        Delete Project
                    </Button>
                </div>
                {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
            </Section>

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-destructive">Delete project</DialogTitle>
                        <DialogDescription>
                            This action cannot be undone. Type{" "}
                            <span className="font-mono text-foreground">{expectedPhrase}</span>{" "}
                            to confirm.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-2 py-2">
                        <Label htmlFor="delete-project-confirmation">Project name</Label>
                        <Input
                            id="delete-project-confirmation"
                            value={confirmName}
                            onChange={(e) => setConfirmName(e.target.value)}
                            placeholder={expectedPhrase}
                            autoFocus
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            className="cursor-pointer"
                            onClick={() => setDialogOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            className="cursor-pointer disabled:cursor-not-allowed"
                            disabled={!confirmed || isDeleting}
                            onClick={handleDelete}
                        >
                            {isDeleting ? "Deleting..." : "Delete project"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
