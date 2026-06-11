"use client";

/** Dropdown selector for switching between project environments and creating new ones. */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useEnvironment } from "@/app/hooks/useEnvironment";
import { ChevronDown, Circle, Copy, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { cn } from "@/app/lib/utils";

/** Color dot indicating environment type: green for production, purple for others. */
export function EnvironmentDot({ isDefault }: { isDefault: boolean }) {
  return (
    <Circle
      className={cn(
        "size-2 fill-current",
        isDefault ? "text-emerald-500" : "text-violet-500",
      )}
    />
  );
}

/** Dropdown to list, switch, and create project environments. */
export function EnvironmentSelector() {
  const params = useParams<{ projectId?: string }>();
  const projectId = params.projectId as Id<"projects"> | undefined;
  const { environmentId, setEnvironmentId } = useEnvironment();

  const environments = useQuery(
    api.environment.list,
    projectId ? { projectId: projectId } : "skip",
  ) as Doc<"environments">[] | undefined;
  const ensureDefault = useMutation(api.environment.ensureDefault);
  const createEnvironment = useMutation(api.environment.create);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [createMode, setCreateMode] = useState<"empty" | "duplicate">("empty");
  const [duplicateFromId, setDuplicateFromId] =
    useState<Id<"environments"> | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Ensure default Production environment exists when project loads
  useEffect(() => {
    if (!projectId || environments === undefined) return;
    if (environments.length === 0) {
      ensureDefault({ projectId: projectId }).catch(console.error);
    }
  }, [projectId, environments, ensureDefault]);

  // Auto-select the default environment when environments load or selection becomes invalid
  useEffect(() => {
    if (!environments || environments.length === 0) return;
    const currentValid = environments.some(
      (e: Doc<"environments">) => e._id === environmentId,
    );
    if (!currentValid) {
      const defaultEnv =
        environments.find((e: Doc<"environments">) => e.isDefault) ??
        environments[0];
      setEnvironmentId(defaultEnv._id);
    }
  }, [environments, environmentId, setEnvironmentId]);

  if (!projectId || !environments || environments.length === 0) {
    return null;
  }

  const selectedEnv = environments.find(
    (e: Doc<"environments">) => e._id === environmentId,
  );

  async function handleCreate() {
    if (!newName.trim() || !projectId) return;
    setIsCreating(true);
    try {
      const newId = await createEnvironment({
        projectId: projectId,
        name: newName.trim(),
        duplicateFromId:
          createMode === "duplicate" && duplicateFromId
            ? duplicateFromId
            : undefined,
      });
      setEnvironmentId(newId);
      setCreateOpen(false);
      setNewName("");
      setCreateMode("empty");
      setDuplicateFromId(null);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto select-none gap-1.5 px-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground active:bg-accent/80 data-[state=open]:bg-accent data-[state=open]:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none cursor-pointer"
          >
            <EnvironmentDot isDefault={selectedEnv?.isDefault ?? false} />
            {selectedEnv?.name ?? "Environment"}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" sideOffset={8} className="w-56">
          <DropdownMenuLabel>Environments</DropdownMenuLabel>
          <DropdownMenuSeparator />

          {environments.map((env: Doc<"environments">) => (
            <DropdownMenuItem
              key={env._id}
              className={cn(
                "gap-2",
                env._id === environmentId
                  ? "bg-accent text-accent-foreground"
                  : "",
              )}
              onClick={() => setEnvironmentId(env._id)}
            >
              <EnvironmentDot isDefault={env.isDefault} />
              {env.name}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setDuplicateFromId(environmentId);
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" />
            New Environment
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New Environment</DialogTitle>
            <DialogDescription>
              Name your environment and choose how to initialize it.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
          >
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="env-name">Environment name</Label>
                <Input
                  id="env-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="staging"
                  autoFocus
                />
              </div>

              <div className="grid gap-2">
                <Label>Initialize from</Label>
                <div className="grid gap-2">
                  <button
                    type="button"
                    onClick={() => setCreateMode("empty")}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                      createMode === "empty"
                        ? "border-cyan-500 bg-cyan-500/10"
                        : "border-border hover:bg-accent/50",
                    )}
                  >
                    <Plus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">Empty environment</p>
                      <p className="text-xs text-muted-foreground">
                        Start fresh with no services or config
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setCreateMode("duplicate")}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                      createMode === "duplicate"
                        ? "border-cyan-500 bg-cyan-500/10"
                        : "border-border hover:bg-accent/50",
                    )}
                  >
                    <Copy className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">Duplicate existing</p>
                      <p className="text-xs text-muted-foreground">
                        Copy all services and config from an environment
                      </p>
                    </div>
                  </button>
                </div>
              </div>

              {createMode === "duplicate" && (
                <div className="grid gap-2">
                  <Label htmlFor="dup-source">Copy from</Label>
                  <Select
                    value={duplicateFromId ?? ""}
                    onValueChange={(val) =>
                      setDuplicateFromId(
                        (val || null) as Id<"environments"> | null,
                      )
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select environment…" />
                    </SelectTrigger>
                    <SelectContent>
                      {environments.map((env: Doc<"environments">) => (
                        <SelectItem key={env._id} value={env._id}>
                          {env.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !newName.trim() ||
                  isCreating ||
                  (createMode === "duplicate" && !duplicateFromId)
                }
              >
                {isCreating ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
