"use client";

/** Danger panel: delete the active environment or the entire project, each behind a typed confirmation. */
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Section } from "@/app/components/Section";
import { useEnvironment } from "@/app/hooks/useEnvironment";
import { Button } from "@/app/components/ui/button";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
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

    const [projectDialogOpen, setProjectDialogOpen] = useState(false);
    const [isDeletingProject, setIsDeletingProject] = useState(false);
    const [projectDeleteError, setProjectDeleteError] = useState<string | null>(null);

    const [envDialogOpen, setEnvDialogOpen] = useState(false);
    const [isDeletingEnv, setIsDeletingEnv] = useState(false);
    const [envDeleteError, setEnvDeleteError] = useState<string | null>(null);

    const activeEnv = environments?.find((env) => env._id === environmentId) ?? null;
    const defaultEnv = environments?.find((env) => env.isDefault) ?? null;
    const canDeleteEnv = Boolean(activeEnv && !activeEnv.isDefault);

    async function handleDeleteProject() {
        setIsDeletingProject(true);
        setProjectDeleteError(null);
        try {
            await removeProject({ projectId: projectId });
            setProjectDialogOpen(false);
            router.replace("/projects");
        } catch (err) {
            setProjectDeleteError(err instanceof Error ? err.message : "Failed to delete project.");
            setIsDeletingProject(false);
        }
    }

    async function handleDeleteEnvironment() {
        if (!activeEnv) return;
        setIsDeletingEnv(true);
        setEnvDeleteError(null);
        try {
            await removeEnvironment({ environmentId: activeEnv._id });
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
                                setProjectDeleteError(null);
                                setProjectDialogOpen(true);
                            }}
                        >
                            Delete Project
                        </Button>
                    </div>
                    {projectDeleteError && <p className="text-sm text-destructive">{projectDeleteError}</p>}
                </Section>
            </div>

            {activeEnv && (
                <DeleteConfirmDialog
                    open={envDialogOpen}
                    onOpenChange={setEnvDialogOpen}
                    resourceName={activeEnv.name}
                    resourceType="environment"
                    critical={true}
                    onConfirm={handleDeleteEnvironment}
                    isDeleting={isDeletingEnv}
                />
            )}

            {project && (
                <DeleteConfirmDialog
                    open={projectDialogOpen}
                    onOpenChange={setProjectDialogOpen}
                    resourceName={project.name}
                    resourceType="project"
                    critical={true}
                    onConfirm={handleDeleteProject}
                    isDeleting={isDeletingProject}
                />
            )}
        </>
    );
}
