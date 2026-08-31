"use client";

/** Dropdown selector for switching between project stages and creating new ones. */
import { Button } from "@/app/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/app/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { Skeleton } from "@/app/components/ui/skeleton";
import { useStage } from "@/app/hooks/useStage";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, Circle, Copy, Plus } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

type StageKind = "development" | "production" | "custom";
type DeploymentRegion = "ap-southeast-1" | "eu-west-1" | "us-east-1";

const regionOptions: Array<{
  value: DeploymentRegion;
  label: string;
  flag: string;
  enabled: boolean;
}> = [
  { value: "eu-west-1", label: "Europe (Ireland)", flag: "🇮🇪", enabled: true },
  {
    value: "ap-southeast-1",
    label: "Asia Pacific (Singapore)",
    flag: "🇸🇬",
    enabled: false,
  },
  {
    value: "us-east-1",
    label: "US East (N. Virginia)",
    flag: "🇺🇸",
    enabled: false,
  },
];

/** Infer stage type for legacy rows that predate the explicit kind field. */
function stageKind(
  stage: Pick<Doc<"stages">, "name" | "kind"> | null | undefined,
): StageKind {
  if (!stage) return "custom";
  if (stage.kind) return stage.kind;
  const normalized = stage.name.trim().toLowerCase();
  if (normalized === "development") return "development";
  if (normalized === "production") return "production";

  return "custom";
}

/** Color dot indicating stage type: green for Development, purple for Production. */
export function StageDot({ kind }: { kind: StageKind }): React.JSX.Element {
  return (
    <Circle
      className={cn(
        "size-2 fill-current",
        kind === "development"
          ? "text-emerald-500"
          : kind === "production"
            ? "text-violet-500"
            : "text-cyan-500",
      )}
    />
  );
}

/**
 * Dropdown to list, switch, and create project stages. The Initialize
 * Production panel opens only when the user selects a Production stage
 * that has no deployment region yet, so nothing else can prompt for one.
 */
export function StageSelector(): React.JSX.Element | null {
  const params = useParams<{ projectId?: string }>();
  const projectId = params.projectId as Id<"projects"> | undefined;
  const { stageId, setStageId } = useStage();

  const stages = useQuery(
    api.stage.list,
    projectId ? { projectId: projectId } : "skip",
  ) as Doc<"stages">[] | undefined;
  const ensureDefault = useMutation(api.stage.ensureDefault);
  const createStage = useMutation(api.stage.create);
  const initializeProduction = useMutation(api.stage.initializeProduction);

  const [createOpen, setCreateOpen] = useState(false);
  const [productionOpen, setProductionOpen] = useState(false);
  const [productionRegion, setProductionRegion] =
    useState<DeploymentRegion>("eu-west-1");
  const [newName, setNewName] = useState("");
  const [createMode, setCreateMode] = useState<"empty" | "duplicate">("empty");
  const [duplicateFromId, setDuplicateFromId] = useState<Id<"stages"> | null>(
    null,
  );
  const [isCreating, setIsCreating] = useState(false);
  const [isInitializingProduction, setIsInitializingProduction] =
    useState(false);

  const developmentStage = stages?.find(
    (stage) => stageKind(stage) === "development",
  );
  const productionStage = stages?.find(
    (stage) => stageKind(stage) === "production",
  );

  // Ensure default Development stage exists when project loads.
  useEffect(() => {
    if (!projectId || stages === undefined) return;
    const defaultStage = stages.find((stage) => stage.isDefault);
    const hasDevelopmentDefault =
      defaultStage && stageKind(defaultStage) === "development";
    if (stages.length === 0 || !developmentStage || !hasDevelopmentDefault) {
      ensureDefault({ projectId: projectId }).catch(console.error);
    }
  }, [projectId, stages, developmentStage, ensureDefault]);

  // Auto-select the default stage when stages load or selection becomes invalid
  useEffect(() => {
    if (!stages || stages.length === 0) return;
    const currentValid = stages.some((e: Doc<"stages">) => e._id === stageId);
    if (!currentValid) {
      const defaultStage =
        stages.find(
          (e: Doc<"stages">) => stageKind(e) === "development" && e.isDefault,
        ) ??
        stages.find((e: Doc<"stages">) => stageKind(e) === "development") ??
        stages.find((e: Doc<"stages">) => e.isDefault) ??
        stages[0];
      setStageId(defaultStage._id);
    }
  }, [stages, stageId, setStageId]);

  if (!projectId) {
    return null;
  }

  // Its divider is already painted on a project route: hold the slot instead of
  // letting the header snap wider when the stages arrive.
  if (stages === undefined) {
    return <Skeleton className="h-4 w-20 bg-muted" />;
  }

  if (stages.length === 0) {
    return null;
  }

  const selectedStage = stages.find((e: Doc<"stages">) => e._id === stageId);
  const selectedKind = stageKind(selectedStage);

  function handleSelectStage(stage: Doc<"stages">) {
    if (stageKind(stage) === "production" && !stage.deploymentRegion) {
      setProductionOpen(true);

      return;
    }

    setStageId(stage._id);
  }

  function handleSelectProductionTarget() {
    if (productionStage?.deploymentRegion) {
      setStageId(productionStage._id);

      return;
    }

    setProductionOpen(true);
  }

  async function handleCreate() {
    if (!newName.trim() || !projectId) return;
    setIsCreating(true);
    try {
      const newId = await createStage({
        projectId: projectId,
        name: newName.trim(),
        duplicateFromId:
          createMode === "duplicate" && duplicateFromId
            ? duplicateFromId
            : undefined,
      });
      setStageId(newId);
      setCreateOpen(false);
      setNewName("");
      setCreateMode("empty");
      setDuplicateFromId(null);
    } finally {
      setIsCreating(false);
    }
  }

  async function handleInitializeProduction() {
    if (!projectId) return;
    const sourceStageId = developmentStage?._id;
    if (!sourceStageId) return;
    setIsInitializingProduction(true);
    try {
      const productionId = await initializeProduction({
        projectId: projectId,
        sourceStageId: sourceStageId,
        deploymentRegion: productionRegion,
      });
      setStageId(productionId);
      setProductionOpen(false);
    } finally {
      setIsInitializingProduction(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="h-auto select-none gap-1.5 px-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground active:bg-accent/80 data-popup-open:bg-accent data-popup-open:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none cursor-pointer"
            />
          }
        >
          <StageDot kind={selectedKind} />
          {selectedStage?.name ?? "Stage"}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          sideOffset={8}
          className="flex max-h-[min(24rem,var(--available-height))] w-56 flex-col overflow-hidden"
        >
          <DropdownMenuGroup className="flex min-h-0 flex-1 flex-col">
            <DropdownMenuLabel>Stages</DropdownMenuLabel>
            <DropdownMenuSeparator />

            <div className="min-h-0 flex-1 overflow-y-auto">
              {stages.map((stage: Doc<"stages">) => (
                <DropdownMenuItem
                  key={stage._id}
                  className={cn(
                    "gap-2 cursor-pointer",
                    stage._id === stageId
                      ? "bg-accent text-accent-foreground"
                      : "",
                  )}
                  onClick={() => handleSelectStage(stage)}
                >
                  <StageDot kind={stageKind(stage)} />
                  {stage.name}
                </DropdownMenuItem>
              ))}

              {!productionStage && (
                <DropdownMenuItem
                  className="gap-2 cursor-pointer"
                  onClick={handleSelectProductionTarget}
                >
                  <StageDot kind="production" />
                  Production
                </DropdownMenuItem>
              )}
            </div>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => {
              setDuplicateFromId(stageId);
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" />
            New Stage
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New Stage</DialogTitle>
            <DialogDescription>
              Name your stage and choose how to initialize it.
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
                <Label htmlFor="stage-name">Stage name</Label>
                <Input
                  id="stage-name"
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
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                      createMode === "empty"
                        ? "border-cyan-500 bg-cyan-500/10"
                        : "border-border hover:bg-accent/50",
                    )}
                  >
                    <Plus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">Empty stage</p>
                      <p className="text-xs text-muted-foreground">
                        Start fresh with no services or config
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setCreateMode("duplicate")}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                      createMode === "duplicate"
                        ? "border-cyan-500 bg-cyan-500/10"
                        : "border-border hover:bg-accent/50",
                    )}
                  >
                    <Copy className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">Duplicate existing</p>
                      <p className="text-xs text-muted-foreground">
                        Copy all services and config from a stage
                      </p>
                    </div>
                  </button>
                </div>
              </div>

              {createMode === "duplicate" && (
                <div className="grid gap-2">
                  <Label htmlFor="dup-source">Copy from</Label>
                  <Select
                    items={stages.map((stage: Doc<"stages">) => ({
                      label: stage.name,
                      value: stage._id,
                    }))}
                    value={duplicateFromId ?? ""}
                    onValueChange={(val) =>
                      setDuplicateFromId((val || null) as Id<"stages"> | null)
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select stage…" />
                    </SelectTrigger>
                    <SelectContent>
                      {stages.map((stage: Doc<"stages">) => (
                        <SelectItem key={stage._id} value={stage._id}>
                          {stage.name}
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
                className="cursor-pointer"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="cursor-pointer disabled:cursor-not-allowed"
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

      <Dialog open={productionOpen} onOpenChange={setProductionOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Initialize Production</DialogTitle>
            <DialogDescription>
              Copy the current Development configuration into a deployable
              Production stage.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-2">
            <Label>Deployment region</Label>
            <div className="grid gap-2">
              {regionOptions.map((region) => (
                <button
                  key={region.value}
                  type="button"
                  disabled={!region.enabled}
                  onClick={() => setProductionRegion(region.value)}
                  className={cn(
                    "flex items-center justify-between rounded-md border px-3 py-2 text-left transition-colors",
                    region.enabled
                      ? "cursor-pointer hover:bg-accent/50"
                      : "cursor-not-allowed opacity-50",
                    productionRegion === region.value
                      ? "border-violet-500 bg-violet-500/10"
                      : "border-border",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-lg">{region.flag}</span>
                    <span className="text-sm font-medium">{region.label}</span>
                  </span>
                  {!region.enabled && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                      Soon
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer"
              onClick={() => setProductionOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="cursor-pointer disabled:cursor-not-allowed"
              disabled={!developmentStage || isInitializingProduction}
              onClick={handleInitializeProduction}
            >
              {isInitializingProduction
                ? "Initializing…"
                : "Initialize Production"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
