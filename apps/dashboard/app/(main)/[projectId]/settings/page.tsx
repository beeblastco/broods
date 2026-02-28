"use client";

/** Settings page for managing project details, environments, and destructive actions. */
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useEnvironment } from "@/app/hooks/useEnvironment";
import { EnvironmentDot } from "@/app/components/EnvironmentSelector";
import { Trash2 } from "lucide-react";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Separator } from "@/app/components/ui/separator";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";

/** Confirmation phrase required to delete an environment. */
const DELETE_ENV_PHRASE = "delete this environment";

export default function SettingsPage() {
    const params = useParams<{ projectId: string }>();
    const projectId = params.projectId as Id<"projects">;
    const router = useRouter();
    const { setEnvironmentId } = useEnvironment();

    const project = useQuery(api.project.getById, { projectId: projectId });
    const environments = useQuery(api.environment.list, { projectId: projectId });

    const updateProject = useMutation(api.project.update);
    const deleteEnvironment = useMutation(api.environment.remove);
    const deleteProject = useMutation(api.project.remove);

    // Editable general fields
    const [editName, setEditName] = useState("");
    const [editDescription, setEditDescription] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    // Sync local state when project loads
    useEffect(() => {
        if (project) {
            setEditName(project.name);
            setEditDescription(project.description ?? "");
        }
    }, [project]);

    // Delete environment dialog state
    const [deleteEnvTarget, setDeleteEnvTarget] = useState<{ id: Id<"environments">; name: string } | null>(null);
    const [confirmEnvPhrase, setConfirmEnvPhrase] = useState("");
    const [isDeletingEnv, setIsDeletingEnv] = useState(false);

    // Delete project dialog state
    const [deleteProjectOpen, setDeleteProjectOpen] = useState(false);
    const [confirmProjectPhrase, setConfirmProjectPhrase] = useState("");
    const [isDeletingProject, setIsDeletingProject] = useState(false);

    const hasGeneralChanges =
        project !== undefined &&
        project !== null &&
        (editName.trim() !== project.name || editDescription.trim() !== (project.description ?? ""));

    async function handleSaveGeneral() {
        if (!hasGeneralChanges || !editName.trim()) return;
        setIsSaving(true);
        try {
            await updateProject({
                projectId: projectId,
                name: editName.trim(),
                description: editDescription.trim() || undefined,
            });
        } finally {
            setIsSaving(false);
        }
    }

    const DELETE_PROJECT_PHRASE = `delete ${project?.name ?? ""}`;

    async function handleDeleteEnvironment() {
        if (!deleteEnvTarget || confirmEnvPhrase !== DELETE_ENV_PHRASE) return;
        setIsDeletingEnv(true);
        try {
            await deleteEnvironment({ environmentId: deleteEnvTarget.id });
            setDeleteEnvTarget(null);
            setConfirmEnvPhrase("");
            setEnvironmentId(null);
        } finally {
            setIsDeletingEnv(false);
        }
    }

    async function handleDeleteProject() {
        if (confirmProjectPhrase !== DELETE_PROJECT_PHRASE) return;
        setIsDeletingProject(true);
        try {
            await deleteProject({ projectId: projectId });
            setDeleteProjectOpen(false);
            router.replace("/");
        } finally {
            setIsDeletingProject(false);
        }
    }

    if (project === undefined || environments === undefined) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">Loading…</p>
            </div>
        );
    }

    if (project === null) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">Project not found.</p>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-2xl px-6 py-10">
            <h1 className="mb-8 text-xl font-semibold text-foreground">Project Settings</h1>

            <div className="grid gap-8">
                {/* General */}
                <Section title="General" description="Basic information about your project.">
                    <div className="grid gap-4">
                        <div className="grid gap-2">
                            <Label htmlFor="project-name">Name</Label>
                            <Input
                                id="project-name"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                                placeholder="My project"
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="project-description">Description</Label>
                            <Input
                                id="project-description"
                                value={editDescription}
                                onChange={(e) => setEditDescription(e.target.value)}
                                placeholder="Optional description"
                            />
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
                            <span className="text-xs text-muted-foreground">Project ID</span>
                            <span className="font-mono text-xs text-muted-foreground">{project._id}</span>
                        </div>
                        <div className="flex justify-end">
                            <Button
                                size="sm"
                                disabled={!hasGeneralChanges || !editName.trim() || isSaving}
                                onClick={handleSaveGeneral}
                            >
                                {isSaving ? "Saving…" : "Save changes"}
                            </Button>
                        </div>
                    </div>
                </Section>

                <Separator />

                {/* Environments */}
                <Section
                    title="Environments"
                    description="Manage deployment environments for this project. The default environment cannot be deleted."
                >
                    <div className="rounded-lg border border-border bg-card divide-y divide-border">
                        {environments.length === 0 && (
                            <p className="px-4 py-3 text-sm text-muted-foreground">No environments yet.</p>
                        )}
                        {environments.map((env) => (
                            <div key={env._id} className="flex items-center gap-3 px-4 py-3">
                                <EnvironmentDot isDefault={env.isDefault} />
                                <span className="flex-1 text-sm font-medium text-foreground">
                                    {env.name}
                                </span>

                                {env.isDefault ? (
                                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                                        Default
                                    </span>
                                ) : (
                                    <button
                                        onClick={() => {
                                            setConfirmEnvPhrase("");
                                            setDeleteEnvTarget({ id: env._id, name: env.name });
                                        }}
                                        className="text-muted-foreground transition-colors hover:text-destructive"
                                        aria-label={`Delete ${env.name}`}
                                    >
                                        <Trash2 className="size-4" />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                </Section>

                <Separator />

                {/* Danger Zone */}
                <Section
                    title="Danger Zone"
                    description="These actions are permanent and cannot be undone."
                    danger
                >
                    <div className="flex items-center justify-between gap-6">
                        <div>
                            <p className="text-sm font-medium text-foreground">Delete project</p>
                            <p className="text-xs text-muted-foreground">
                                Permanently removes this project, all environments, and all agent configurations.
                            </p>
                        </div>
                        <Button
                            variant="destructive"
                            size="sm"
                            className="shrink-0"
                            onClick={() => {
                                setConfirmProjectPhrase("");
                                setDeleteProjectOpen(true);
                            }}
                        >
                            Delete Project
                        </Button>
                    </div>
                </Section>
            </div>

            {/* Delete environment confirmation dialog */}
            <Dialog
                open={!!deleteEnvTarget}
                onOpenChange={(open) => {
                    if (!open) {
                        setDeleteEnvTarget(null);
                        setConfirmEnvPhrase("");
                    }
                }}
            >
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete environment</DialogTitle>
                        <DialogDescription asChild>
                            <div className="grid gap-3 text-sm text-muted-foreground">
                                <p>
                                    This will permanently delete the{" "}
                                    <span className="font-semibold text-foreground">
                                        {deleteEnvTarget?.name}
                                    </span>{" "}
                                    environment and cannot be undone.
                                </p>
                                <p>
                                    All agent configurations, canvas layouts, and sessions inside this
                                    environment will be deleted forever.
                                </p>
                            </div>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-2">
                        <Label htmlFor="confirm-env-phrase" className="grid gap-1">
                            <span>Type the following to confirm</span>
                            <span className="font-mono font-medium text-foreground break-all">
                                {DELETE_ENV_PHRASE}
                            </span>
                        </Label>
                        <Input
                            id="confirm-env-phrase"
                            value={confirmEnvPhrase}
                            onChange={(e) => setConfirmEnvPhrase(e.target.value)}
                            placeholder={DELETE_ENV_PHRASE}
                            autoFocus
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setDeleteEnvTarget(null);
                                setConfirmEnvPhrase("");
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={confirmEnvPhrase !== DELETE_ENV_PHRASE || isDeletingEnv}
                            onClick={handleDeleteEnvironment}
                        >
                            {isDeletingEnv ? "Deleting…" : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete project confirmation dialog */}
            <Dialog
                open={deleteProjectOpen}
                onOpenChange={(open) => {
                    if (!open) {
                        setDeleteProjectOpen(false);
                        setConfirmProjectPhrase("");
                    }
                }}
            >
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete project</DialogTitle>
                        <DialogDescription asChild>
                            <div className="grid gap-3 text-sm text-muted-foreground">
                                <p>
                                    This will permanently delete{" "}
                                    <span className="font-semibold text-foreground">{project.name}</span>{" "}
                                    and cannot be undone.
                                </p>
                                <p>
                                    All environments, agent configurations, canvas layouts, and sessions
                                    inside this project will be deleted forever.
                                </p>
                            </div>
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-2">
                        <Label htmlFor="confirm-project-phrase" className="grid gap-1">
                            <span>Type the following to confirm</span>
                            <span className="font-mono font-medium text-foreground break-all">
                                {DELETE_PROJECT_PHRASE}
                            </span>
                        </Label>
                        <Input
                            id="confirm-project-phrase"
                            value={confirmProjectPhrase}
                            onChange={(e) => setConfirmProjectPhrase(e.target.value)}
                            placeholder={DELETE_PROJECT_PHRASE}
                            autoFocus
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setDeleteProjectOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={confirmProjectPhrase !== DELETE_PROJECT_PHRASE || isDeletingProject}
                            onClick={handleDeleteProject}
                        >
                            {isDeletingProject ? "Deleting…" : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
