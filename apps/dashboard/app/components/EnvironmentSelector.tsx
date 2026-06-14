"use client";

/** Dropdown selector for switching between project environments and creating new ones. */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Doc, Id } from "@filthy-panty/convex/_generated/dataModel";
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

type EnvironmentKind = "development" | "production" | "custom";
type DeploymentRegion = "ap-southeast-1" | "eu-central-1" | "us-east-1";

const regionOptions: Array<{ value: DeploymentRegion; label: string; flag: string; enabled: boolean }> = [
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore)", flag: "🇸🇬", enabled: true },
  { value: "eu-central-1", label: "Europe (Frankfurt)", flag: "🇩🇪", enabled: false },
  { value: "us-east-1", label: "US East (N. Virginia)", flag: "🇺🇸", enabled: false },
];

/** Infer environment type for legacy rows that predate the explicit kind field. */
function environmentKind(env: Pick<Doc<"environments">, "name" | "kind"> | null | undefined): EnvironmentKind {
  if (!env) return "custom";
  if (env.kind) return env.kind;
  const normalized = env.name.trim().toLowerCase();
  if (normalized === "development") return "development";
  if (normalized === "production") return "production";

  return "custom";
}

/** Color dot indicating environment type: green for Development, purple for Production. */
export function EnvironmentDot({ kind }: { kind: EnvironmentKind }) {
  return (
    <Circle
      className={cn(
        "size-2 fill-current",
        kind === "development" ? "text-emerald-500" : kind === "production" ? "text-violet-500" : "text-cyan-500",
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
  const initializeProduction = useMutation(api.environment.initializeProduction);

  const [createOpen, setCreateOpen] = useState(false);
  const [productionOpen, setProductionOpen] = useState(false);
  const [productionRegion, setProductionRegion] = useState<DeploymentRegion>("ap-southeast-1");
  const [newName, setNewName] = useState("");
  const [createMode, setCreateMode] = useState<"empty" | "duplicate">("empty");
  const [duplicateFromId, setDuplicateFromId] =
    useState<Id<"environments"> | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isInitializingProduction, setIsInitializingProduction] = useState(false);

  const developmentEnv = environments?.find((env) => environmentKind(env) === "development");
  const productionEnv = environments?.find((env) => environmentKind(env) === "production");

  // Ensure default Development environment exists when project loads.
  useEffect(() => {
    if (!projectId || environments === undefined) return;
    const defaultEnv = environments.find((env) => env.isDefault);
    const hasDevelopmentDefault = defaultEnv && environmentKind(defaultEnv) === "development";
    if (environments.length === 0 || !developmentEnv || !hasDevelopmentDefault) {
      ensureDefault({ projectId: projectId }).catch(console.error);
    }
  }, [projectId, environments, developmentEnv, ensureDefault]);

  // Auto-select the default environment when environments load or selection becomes invalid
  useEffect(() => {
    if (!environments || environments.length === 0) return;
    const currentValid = environments.some(
      (e: Doc<"environments">) => e._id === environmentId,
    );
    if (!currentValid) {
      const defaultEnv =
        environments.find((e: Doc<"environments">) => environmentKind(e) === "development" && e.isDefault) ??
        environments.find((e: Doc<"environments">) => environmentKind(e) === "development") ??
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
  const selectedKind = environmentKind(selectedEnv);

  function handleSelectEnvironment(env: Doc<"environments">) {
    if (environmentKind(env) === "production" && !env.deploymentRegion) {
      setProductionOpen(true);

      return;
    }

    setEnvironmentId(env._id);
  }

  function handleSelectProductionTarget() {
    if (productionEnv?.deploymentRegion) {
      setEnvironmentId(productionEnv._id);

      return;
    }

    setProductionOpen(true);
  }

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

  async function handleInitializeProduction() {
    if (!projectId) return;
    const sourceEnvironmentId = developmentEnv?._id;
    if (!sourceEnvironmentId) return;
    setIsInitializingProduction(true);
    try {
      const productionId = await initializeProduction({
        projectId: projectId,
        sourceEnvironmentId: sourceEnvironmentId,
        deploymentRegion: productionRegion,
      });
      setEnvironmentId(productionId);
      setProductionOpen(false);
    } finally {
      setIsInitializingProduction(false);
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
            <EnvironmentDot kind={selectedKind} />
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
                "gap-2 cursor-pointer",
                env._id === environmentId
                  ? "bg-accent text-accent-foreground"
                  : "",
              )}
              onClick={() => handleSelectEnvironment(env)}
            >
              <EnvironmentDot kind={environmentKind(env)} />
              {env.name}
            </DropdownMenuItem>
          ))}

          {!productionEnv && (
            <DropdownMenuItem
              className="gap-2 cursor-pointer"
              onClick={handleSelectProductionTarget}
            >
              <EnvironmentDot kind="production" />
              Production
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer"
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
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left transition-colors",
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
              Copy the current Development configuration into a deployable Production environment.
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
                    region.enabled ? "cursor-pointer hover:bg-accent/50" : "cursor-not-allowed opacity-50",
                    productionRegion === region.value
                      ? "border-violet-500 bg-violet-500/10"
                      : "border-border",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-lg">{region.flag}</span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{region.label}</span>
                      <span className="text-xs text-muted-foreground">{region.value}</span>
                    </span>
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
              disabled={!developmentEnv || isInitializingProduction}
              onClick={handleInitializeProduction}
            >
              {isInitializingProduction ? "Initializing…" : "Initialize Production"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
