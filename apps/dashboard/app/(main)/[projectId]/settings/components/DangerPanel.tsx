"use client";

/** Danger panel: delete the active environment or the entire project, each behind a confirmation. */
import { Section } from "@/app/components/Section";
import { useEnvironment } from "@/app/hooks/useEnvironment";
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
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
    /** Project to delete. */
    projectId: Id<"projects">;
    /** Active environment that the environment-scoped delete acts on, or null. */
    environmentId: Id<"environments"> | null;
}

export function DangerPanel({ projectId, environmentId }: Props) {
    const project = useQuery(api.project.getById, { projectId: projectId });
    const environments = useQuery(api.environment.list, { projectId: projectId }) as
        | Doc<"environments">[]
        | undefined;
    const removeProject = useMutation(api.project.remove);
    const removeEnvironment = useMutation(api.environment.remove);
    const { setEnvironmentId } = useEnvironment();
    const router = useRouter();

    const [dialogOpen, setDialogOpen] = useState(false);
    const [confirmName, setConfirmName] = useState("");
    const [isDeleting, setIsDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const [envDialogOpen, setEnvDialogOpen] = useState(false);
    const [isDeletingEnv, setIsDeletingEnv] = useState(false);
    const [envDeleteError, setEnvDeleteError] = useState<string | null>(null);

    const activeEnv = environments?.find((env) => env._id === environmentId) ?? null;
    const defaultEnv = environments?.find((env) => env.isDefault) ?? null;
    const canDeleteEnv = Boolean(activeEnv && !activeEnv.isDefault);

    const expectedPhrase = project?.name ?? "";
    const confirmed = confirmName.trim() === expectedPhrase;

    async function handleDeleteProject() {
        if (!confirmed) return;
        setIsDeleting(true);
        setDeleteError(null);
        try {
            await removeProject({ projectId: projectId });
            // Land on the project gallery rather than auto-opening/recreating a project.
            router.replace("/projects");
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : "Failed to delete project.");
            setIsDeleting(false);
        }
    }

    async function handleDeleteEnvironment() {
        if (!activeEnv) return;
        setIsDeletingEnv(true);
        setEnvDeleteError(null);
        try {
            await removeEnvironment({ environmentId: activeEnv._id });
            // Return to the default environment after deleting the active one.
            setEnvironmentId(defaultEnv ? defaultEnv._id : null);
            setEnvDialogOpen(false);
        } catch (err) {
            setEnvDeleteError(err instanceof Error ? err.message : "Failed to delete environment.");
        } finally {
            setIsDeletingEnv(false);
        }
    }

    return (
        <>
            <div className="grid gap-6">
                <Section
                    title="Delete Environment"
                    description="Permanently delete the selected environment and all of its data. This cannot be undone."
                    danger
                >
                    <div className="flex items-center justify-between gap-6">
                        <div>
                            <p className="text-sm font-medium text-foreground">
                                Delete {activeEnv ? `"${activeEnv.name}"` : "this environment"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {activeEnv?.isDefault
                                    ? "The default environment can't be deleted."
                                    : "All agents, services, variables, deploy keys, and webhooks in this environment will be removed."}
                            </p>
                        </div>
                        <Button
                            variant="destructive"
                            size="sm"
                            className="shrink-0 cursor-pointer disabled:cursor-not-allowed"
                            disabled={!canDeleteEnv}
                            onClick={() => {
                                setEnvDeleteError(null);
                                setEnvDialogOpen(true);
                            }}
                        >
                            Delete Environment
                        </Button>
                    </div>
                    {envDeleteError && <p className="text-sm text-destructive">{envDeleteError}</p>}
                </Section>

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
            </div>

            <Dialog open={envDialogOpen} onOpenChange={setEnvDialogOpen}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete environment?</DialogTitle>
                        <DialogDescription>
                            {activeEnv
                                ? `This permanently deletes "${activeEnv.name}" and all of its agents, services, variables, deploy keys, and webhooks. This cannot be undone.`
                                : ""}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            className="cursor-pointer"
                            onClick={() => setEnvDialogOpen(false)}
                            disabled={isDeletingEnv}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            className="cursor-pointer disabled:cursor-not-allowed"
                            onClick={handleDeleteEnvironment}
                            disabled={isDeletingEnv}
                        >
                            {isDeletingEnv ? "Deleting…" : "Delete environment"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

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
                            onClick={handleDeleteProject}
                        >
                            {isDeleting ? "Deleting..." : "Delete project"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
