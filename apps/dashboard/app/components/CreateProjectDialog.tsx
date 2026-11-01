"use client";

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
import { markProjectCreated } from "@/app/lib/createdProject";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@broods/convex/_generated/api";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { analytics } from "@/app/lib/analytics";
import { useEffect, useRef, useState } from "react";

export async function randomProjectName(): Promise<string> {
  const { uniqueNamesGenerator, adjectives, animals, NumberDictionary } =
    await import("unique-names-generator");
  const numberDict = NumberDictionary.generate({ min: 100, max: 999 });

  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals, numberDict],
    separator: "-",
    length: 3,
  });
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  description = "Name your new project.",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description?: string;
}): React.JSX.Element {
  const createProject = useMutation(api.project.create);
  const router = useRouter();
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- async name dictionary import
  useEffect(() => {
    if (!open) return;

    let isCancelled = false;

    randomProjectName()
      .then((generatedName) => {
        if (!isCancelled) {
          setName(generatedName);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setName("new-project");
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [open]);

  function handleOpenChange(next: boolean): void {
    if (!next) {
      setName("");
      setError(null);
    }
    onOpenChange(next);
  }

  async function handleCreate(): Promise<void> {
    if (!name.trim()) return;
    setIsCreating(true);
    setError(null);
    try {
      const id = await createProject({
        name: name.trim(),
        description: undefined,
      });
      void analytics.then((posthog): void => {
        posthog.capture("project_created");
      });
      handleOpenChange(false);
      markProjectCreated(id);
      router.push(`/${id}`);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm" initialFocus={nameInput}>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
        >
          <div className="grid gap-3 py-4">
            <Label htmlFor="create-project-name">Project name</Label>
            <Input
              ref={nameInput}
              id="create-project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="cursor-pointer"
              disabled={!name.trim() || isCreating}
            >
              {isCreating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
