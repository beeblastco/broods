"use client";

import { useOpenBilling } from "@/app/hooks/useOrgSeats";
import { useSignedIn } from "@/app/hooks/useSignedIn";
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
import { clientErrorData } from "@broods/convex/model/clientError";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { Building2, Check, ChevronDown, Plus, Settings } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toErrorMessage } from "@/app/lib/errors";

export function OrgSwitcher(): React.JSX.Element {
  const router = useRouter();
  const convex = useConvex();
  const params = useParams<{ projectId?: string }>();
  const orgQueryArgs = useSignedIn() ? {} : "skip";
  const orgs = useQuery(api.org.orgs.list, orgQueryArgs);
  const active = useQuery(api.org.orgs.getActive, orgQueryArgs);
  const currentUser = useQuery(api.user.getCurrent, orgQueryArgs);
  const setActive = useMutation(api.org.orgs.setActive);
  const createOrg = useMutation(api.org.orgs.create);
  const provision = useAction(api.org.lifecycle.provision);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [needsPro, setNeedsPro] = useState<string | null>(null);
  const openBilling = useOpenBilling();
  const hobbyOrg = orgs?.find(
    (org) => org.plan === "free" && org.ownerAuthId === currentUser?.authId,
  );

  async function handleSwitch(orgId: Id<"orgs">): Promise<void> {
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

  async function handleCreate(): Promise<void> {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      const orgId = await createOrg({ name: name });
      await setActive({ orgId: orgId });

      // `provision` throws when the org is already provisioned; that is fine.
      try {
        const result = await provision({ orgId: orgId });
        publishOnboardingSecret(result.secret);
      } catch (provisionErr) {
        console.warn("Auto-provision skipped:", provisionErr);
      }

      setCreateOpen(false);
      setNewName("");
      router.replace("/projects");
      router.refresh();
    } catch (err) {
      const refusal = clientErrorData(err);
      if (refusal?.code === "payment_required") setNeedsPro(refusal.message);
      else setCreateError(toErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  function closeCreate(): void {
    setCreateOpen(false);
    setCreateError(null);
    setNeedsPro(null);
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
            <DropdownMenuLabel variant="muted" className="text-xs">
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

      <Dialog
        open={createOpen}
        onOpenChange={(open) => (open ? setCreateOpen(true) : closeCreate())}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New organization</DialogTitle>
            <DialogDescription>
              An organization has its own projects, members and plan.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <Label htmlFor="new-org-name" variant="muted" className="text-xs">
              Name
            </Label>
            <Input
              id="new-org-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Acme Inc."
              autoComplete="off"
            />
            {needsPro && (
              <div
                className="mt-1 grid gap-1 rounded-md bg-muted px-3 py-2.5 text-xs"
                data-testid="create-org-needs-pro"
              >
                <p className="font-medium text-foreground">{needsPro}</p>
                <p className="text-muted-foreground">
                  You can still join an org when its owner invites you.
                </p>
              </div>
            )}
            {createError && (
              <p className="text-xs text-destructive">{createError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              className="cursor-pointer"
              onClick={closeCreate}
              disabled={creating}
            >
              Cancel
            </Button>
            {needsPro && hobbyOrg && (
              <Button
                variant="outline"
                className="cursor-pointer"
                onClick={() => {
                  closeCreate();
                  void openBilling(hobbyOrg._id);
                }}
              >
                Upgrade to Pro
              </Button>
            )}
            <Button
              className="cursor-pointer"
              disabled={creating || !newName.trim() || needsPro !== null}
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
