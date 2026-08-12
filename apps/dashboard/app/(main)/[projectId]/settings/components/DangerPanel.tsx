"use client";

/** Danger panel: delete the active stage or the entire project, each behind a typed confirmation. */
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { useStage } from "@/app/hooks/useStage";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  /** Project to delete. */
  projectId: Id<"projects">;
  /** Active stage that the stage-scoped delete acts on, or null. */
  stageId: Id<"stages"> | null;
}

export function DangerPanel({ projectId, stageId }: Props) {
  const project = useQuery(api.project.getById, { projectId: projectId });
  const stages = useQuery(api.stage.list, {
    projectId: projectId,
  }) as Doc<"stages">[] | undefined;
  const removeProject = useMutation(api.project.remove);
  const removeStage = useMutation(api.stage.remove);
  const { setStageId } = useStage();
  const router = useRouter();

  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [isDeletingProject, setIsDeletingProject] = useState(false);
  const [projectDeleteError, setProjectDeleteError] = useState<string | null>(
    null,
  );

  const [stageDialogOpen, setStageDialogOpen] = useState(false);
  const [isDeletingStage, setIsDeletingStage] = useState(false);
  const [stageDeleteError, setStageDeleteError] = useState<string | null>(null);

  const activeStage = stages?.find((stage) => stage._id === stageId) ?? null;
  const defaultStage = stages?.find((stage) => stage.isDefault) ?? null;
  const canDeleteStage = Boolean(activeStage && !activeStage.isDefault);

  async function handleDeleteProject() {
    setIsDeletingProject(true);
    setProjectDeleteError(null);
    try {
      await removeProject({ projectId: projectId });
      setProjectDialogOpen(false);
      router.replace("/projects");
    } catch (err) {
      setProjectDeleteError(
        err instanceof Error ? err.message : "Failed to delete project.",
      );
      setIsDeletingProject(false);
    }
  }

  async function handleDeleteStage() {
    if (!activeStage) return;
    setIsDeletingStage(true);
    setStageDeleteError(null);
    try {
      await removeStage({ stageId: activeStage._id });
      setStageId(defaultStage ? defaultStage._id : null);
      setStageDialogOpen(false);
    } catch (err) {
      setStageDeleteError(
        err instanceof Error ? err.message : "Failed to delete stage.",
      );
    } finally {
      setIsDeletingStage(false);
    }
  }

  return (
    <>
      <div className="grid gap-6">
        <Section
          title="Delete Stage"
          description="Permanently delete the selected stage and all of its data. This cannot be undone."
          danger
        >
          <div className="flex items-center justify-between gap-6">
            <div>
              <p className="text-sm font-medium text-foreground">
                Delete {activeStage ? `"${activeStage.name}"` : "this stage"}
              </p>
              <p className="text-xs text-muted-foreground">
                {activeStage?.isDefault
                  ? "The default stage can't be deleted."
                  : "All agents, services, variables, deploy keys, and webhooks in this stage will be removed."}
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0 cursor-pointer disabled:cursor-not-allowed"
              disabled={!canDeleteStage}
              onClick={() => {
                setStageDeleteError(null);
                setStageDialogOpen(true);
              }}
            >
              Delete Stage
            </Button>
          </div>
          {stageDeleteError && (
            <p className="text-sm text-destructive">{stageDeleteError}</p>
          )}
        </Section>

        <Section
          title="Delete Project"
          description="Permanently delete this project and all its data. This cannot be undone."
          danger
        >
          <div className="flex items-center justify-between gap-6">
            <div>
              <p className="text-sm font-medium text-foreground">
                Delete this project
              </p>
              <p className="text-xs text-muted-foreground">
                All stages, agent configs, canvas layouts, and variables will be
                permanently removed.
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
          {projectDeleteError && (
            <p className="text-sm text-destructive">{projectDeleteError}</p>
          )}
        </Section>
      </div>

      {activeStage && (
        <DeleteConfirmDialog
          open={stageDialogOpen}
          onOpenChange={setStageDialogOpen}
          resourceName={activeStage.name}
          resourceType="stage"
          critical={true}
          onConfirm={handleDeleteStage}
          isDeleting={isDeletingStage}
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
