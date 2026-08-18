"use client";

/**
 * Org switcher dropdown rendered in the header. Lists every org the user
 * belongs to, lets them switch active org, jump to org settings, or create
 * a new one via a dialog.
 */

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
import { publishOnboardingSecret } from "@/app/lib/onboardingSecret";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import {
  useAction,
  useConvex,
  useConvexAuth,
  useMutation,
  useQuery,
} from "convex/react";
import { Building2, Check, ChevronDown, Plus, Settings } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

export function OrgSwitcher(): React.JSX.Element {
  const router = useRouter();
  const convex = useConvex();
  const params = useParams<{ projectId?: string }>();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const orgQueryArgs = !isLoading && isAuthenticated ? {} : "skip";
  const orgs = useQuery(api.org.list, orgQueryArgs);
  const active = useQuery(api.org.getActive, orgQueryArgs);
  const setActive = useMutation(api.org.setActive);
  const createOrg = useMutation(api.org.create);
  const provision = useAction(api.orgLifecycle.provision);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Switching org invalidates whatever project the URL points at: send the user
  // to the gallery when the new org has none, so they can create their first.
  async function handleSwitch(orgId: Id<"orgs">) {
    if (active?._id === orgId) return;
    try {
      await setActive({ orgId: orgId });
      const projects = await convex.query(api.project.list, {});
      if (projects.length === 0) {
        router.replace("/projects");
      } else if (
        params.projectId &&
        !projects.some((project) => project._id === params.projectId)
      ) {
        router.replace(`/${projects[0]._id}`);
      }
      router.refresh();
    } catch (err) {
      console.error("Failed to switch org:", err);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const orgId = await createOrg({ name: name });
      await setActive({ orgId: orgId });

      // Auto-provision the new org's backend account and surface its one-time
      // secret. `provision` throws if already provisioned, which we ignore.
      try {
        const result = await provision({ orgId: orgId });
        publishOnboardingSecret(result.secret);
      } catch (provisionErr) {
        console.warn("Auto-provision skipped:", provisionErr);
      }

      setCreateOpen(false);
      setNewName("");
      // A fresh org has no projects yet, so the gallery is the only useful landing.
      router.replace("/projects");
      router.refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  const label =
    active?.name ?? (active === null ? "No organization" : "Loading...");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex select-none items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none active:bg-accent/80 data-popup-open:bg-accent data-popup-open:text-foreground cursor-pointer">
          <Building2 className="size-3.5 text-muted-foreground" />
          <span className="max-w-40 truncate">{label}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={8}
          className="flex max-h-[min(24rem,var(--available-height))] w-64 flex-col overflow-hidden"
        >
          <DropdownMenuGroup className="flex min-h-0 flex-1 flex-col">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Organizations
            </DropdownMenuLabel>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {orgs === undefined ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  Loading...
                </div>
              ) : orgs.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  No organizations yet.
                </div>
              ) : (
                orgs.map((org) => (
                  <DropdownMenuItem
                    key={org._id}
                    className="cursor-pointer"
                    onClick={() => handleSwitch(org._id)}
                  >
                    <Building2 />
                    <span className="flex-1 truncate">{org.name}</span>
                    {active?._id === org._id && (
                      <Check className="size-3.5 text-muted-foreground" />
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </div>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => setCreateOpen(true)}
          >
            <Plus />
            Create organization
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => router.push("/settings/org")}
          >
            <Settings />
            Organization settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create organization</DialogTitle>
            <DialogDescription>
              New orgs start on the free plan. You can rename or upgrade later.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label
              htmlFor="new-org-name"
              className="text-xs text-muted-foreground"
            >
              Name
            </Label>
            <Input
              id="new-org-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Acme Inc."
              autoComplete="off"
            />
            {createError && (
              <p className="text-xs text-destructive">{createError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              className="cursor-pointer disabled:cursor-not-allowed"
              disabled={creating || !newName.trim()}
              onClick={handleCreate}
            >
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
