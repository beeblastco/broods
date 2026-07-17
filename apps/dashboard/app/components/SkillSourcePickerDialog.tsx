"use client";

/** Dialog for selecting how a new skill should be added. */
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import { FolderOpen, GitBranch, Sparkles } from "lucide-react";

export type SkillSource = "files" | "github" | "json";

const SOURCE_OPTIONS = [
  {
    key: "files" as SkillSource,
    label: "Upload files",
    icon: FolderOpen,
    description: "Manage skill files locally and publish to your account.",
  },
  {
    key: "github" as SkillSource,
    label: "GitHub repository",
    icon: GitBranch,
    description: "Import directly from a GitHub repository URL.",
  },
  {
    key: "json" as SkillSource,
    label: "Quick create",
    icon: Sparkles,
    description: "Write a skill with name, description, and instructions.",
  },
] as const;

/** Dialog for selecting the source when adding a new skill node. */
export function SkillSourcePickerDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (source: SkillSource) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs gap-0 p-1">
        <DialogHeader className="px-3 pb-1 pt-3">
          <DialogTitle className="text-sm font-medium text-foreground/80">
            Add skill
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Select how to provide this skill
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col">
          {SOURCE_OPTIONS.map(({ key, label, icon: Icon }) => (
            <Button
              key={key}
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
                onSelect(key);
              }}
              className="h-auto justify-start gap-2 rounded-lg px-3 py-2.5 text-sm text-muted-foreground"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground/60" />
              {label}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
