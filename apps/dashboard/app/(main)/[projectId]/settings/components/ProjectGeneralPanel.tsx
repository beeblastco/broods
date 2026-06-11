"use client";

/** Project general settings: rename the project and view its slug. */
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Textarea } from "@/app/components/ui/textarea";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

interface Props {
  /** Project being edited. */
  projectId: Id<"projects">;
}

export function ProjectGeneralPanel({ projectId }: Props) {
  const project = useQuery(api.project.getById, { projectId: projectId });
  const update = useMutation(api.project.update);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [syncedProject, setSyncedProject] = useState(project);

  // Sync editable fields from the project as it loads or changes (set during
  // render instead of in an effect to avoid a cascading re-render).
  if (project && project !== syncedProject) {
    setSyncedProject(project);
    setName(project.name);
    setDescription(project.description ?? "");
  }

  if (!project) {
    return (
      <Section
        title="Project details"
        description="Rename this project or update its description."
      >
        <p className="text-sm text-muted-foreground">Loading...</p>
      </Section>
    );
  }

  const trimmedName = name.trim();
  const trimmedDesc = description.trim();
  const dirty =
    (trimmedName.length > 0 && trimmedName !== project.name) ||
    trimmedDesc !== (project.description ?? "");

  async function handleSave() {
    if (!dirty || !trimmedName) return;
    setSaving(true);
    setSaveError(null);
    try {
      await update({
        projectId: projectId,
        name: trimmedName,
        description: trimmedDesc || undefined,
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Project details"
      description="Rename this project or update its description."
    >
      <div className="grid gap-4">
        <div className="grid gap-1">
          <Label
            htmlFor="project-name"
            className="text-xs text-muted-foreground"
          >
            Name
          </Label>
          <Input
            id="project-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSaveError(null);
            }}
          />
          <p className="text-xs text-muted-foreground">
            Slug: <code className="font-mono">{project.slug}</code>
          </p>
        </div>

        <div className="grid gap-1">
          <Label
            htmlFor="project-description"
            className="text-xs text-muted-foreground"
          >
            Description
          </Label>
          <Textarea
            id="project-description"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setSaveError(null);
            }}
            placeholder="Optional project description"
            className="resize-none"
            rows={3}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}
          <Button
            size="sm"
            className="cursor-pointer disabled:cursor-not-allowed ml-auto"
            disabled={!dirty || !trimmedName || saving}
            onClick={handleSave}
          >
            {saving ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
    </Section>
  );
}
