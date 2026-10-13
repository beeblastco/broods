"use client";

import { Section } from "@/app/components/Section";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/app/components/ui/avatar";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Separator } from "@/app/components/ui/separator";
import { useOpenBilling } from "@/app/hooks/useOrgSeats";
import { toErrorMessage } from "@/app/lib/errors";
import { SEAT_PRICE_EUR, seatCount } from "@/app/lib/pricing";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { useSession } from "@/app/lib/session";
import { useMutation, useQuery } from "convex/react";
import { ArrowRight, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";

const HANDLE_REGEX = /^[a-z0-9_-]{3,32}$/;

export function AccountPanel(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const { user: authUser } = useSession();

  const currentUser = useQuery(api.user.getCurrent);
  const updateProfile = useMutation(
    api.user.updateProfile,
  ).withOptimisticUpdate((localStore, args) => {
    const existing = localStore.getQuery(api.user.getCurrent, {});
    if (!existing) {
      return;
    }

    localStore.setQuery(
      api.user.getCurrent,
      {},
      {
        ...existing,
        name: args.name,
        accountHandle: args.accountHandle,
      },
    );
  });

  const authFirstName = authUser?.firstName ?? "";
  const authLastName = authUser?.lastName ?? "";
  const claimName =
    (`${authFirstName} ${authLastName}`.trim() || authUser?.email) ?? "User";
  const claimEmail = authUser?.email ?? "Not available";
  const claimAvatar = authUser?.profilePictureUrl ?? null;
  const claimNameRef = useRef(claimName);

  // Keep the latest claim name in a ref for the sync effect below without
  // re-triggering it (refs must not be written during render).
  useEffect(() => {
    claimNameRef.current = claimName;
  }, [claimName]);

  const [name, setName] = useState("");
  const [accountHandle, setAccountHandle] = useState("");
  const [savedProfile, setSavedProfile] = useState<{
    name: string;
    accountHandle: string;
  } | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  useEffect(() => {
    if (currentUser === undefined || isDirty) return;
    const nextName = currentUser?.name ?? claimNameRef.current;
    const nextHandle = currentUser?.accountHandle ?? "";
    setName(nextName);
    setAccountHandle(nextHandle);
    setSavedProfile({
      name: nextName.trim(),
      accountHandle: nextHandle.trim().toLowerCase(),
    });
  }, [currentUser, isDirty]);

  const normalizedHandle = accountHandle.trim().toLowerCase();
  const hasHandleError =
    normalizedHandle.length > 0 && !HANDLE_REGEX.test(normalizedHandle);
  const hasProfileChanges =
    savedProfile !== null &&
    (name.trim() !== savedProfile.name ||
      normalizedHandle !== savedProfile.accountHandle);
  const avatarUrl = currentUser?.avatarUrl ?? claimAvatar;
  const accountId = currentUser?._id ?? authUser?.id ?? "";
  const email = currentUser?.email ?? claimEmail;

  async function handleSaveProfile(): Promise<void> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setSaveError("Display name is required.");

      return;
    }
    if (hasHandleError) {
      setSaveError(
        "Account handle must be 3-32 chars and use a-z, 0-9, '_' or '-'.",
      );

      return;
    }
    setIsSavingProfile(true);
    setSaveError(null);
    setSaveNotice(null);
    try {
      await updateProfile({
        name: trimmedName,
        accountHandle: normalizedHandle || undefined,
      });
      setName(trimmedName);
      setAccountHandle(normalizedHandle);
      setSavedProfile({ name: trimmedName, accountHandle: normalizedHandle });
      setIsDirty(false);
      setSaveNotice("Changes saved.");
    } catch (error) {
      setSaveError(toErrorMessage(error));
    } finally {
      setIsSavingProfile(false);
    }
  }

  if (currentUser === undefined) {
    return (
      <div className="flex h-40 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="grid gap-8">
      <Section
        title="Profile"
        description="Editable attributes for your account."
      >
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="account-display-name">Display name</Label>
            <Input
              id="account-display-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setIsDirty(true);
                setSaveError(null);
                setSaveNotice(null);
              }}
              placeholder="Your display name"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="account-handle">Account handle</Label>
            <Input
              id="account-handle"
              value={accountHandle}
              onChange={(event) => {
                setAccountHandle(event.target.value);
                setIsDirty(true);
                setSaveError(null);
                setSaveNotice(null);
              }}
              placeholder="your_handle"
            />
            <p
              className={cn(
                "text-xs",
                hasHandleError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {hasHandleError
                ? "Use 3-32 chars: lowercase letters, numbers, '_' or '-'."
                : "Public identifier shown as @handle."}
            </p>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {hasProfileChanges
                ? "You have unsaved changes."
                : (saveNotice ?? "All changes saved.")}
            </p>
            <Button
              size="sm"
              className="cursor-pointer"
              onClick={handleSaveProfile}
              disabled={
                !hasProfileChanges ||
                hasHandleError ||
                !name.trim() ||
                isSavingProfile
              }
            >
              {isSavingProfile ? "Saving..." : "Save changes"}
            </Button>
          </div>
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
        </div>
      </Section>

      <Separator />

      <Section
        title="Avatar"
        description="Preview from your identity provider."
      >
        <div className="flex items-center gap-5 rounded-lg border border-border bg-card px-5 py-4">
          <Avatar className="size-24">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={name || "User"} />}
            <AvatarFallback className="text-xl font-semibold">
              {(name || "U")
                .split(" ")
                .map((part) => part[0])
                .slice(0, 2)
                .join("")
                .toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="grid gap-1">
            <p className="text-sm font-medium text-foreground">Profile photo</p>
            <p className="text-xs text-muted-foreground">
              Avatar URL is hidden here. This is a larger preview only.
            </p>
          </div>
        </div>
      </Section>

      <Separator />

      <Section
        title="Account overview"
        description="Read-only account details."
      >
        <div className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">Email</span>
            <span className="text-sm text-foreground">{email}</span>
          </div>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">Account ID</span>
            <span className="font-mono text-xs text-muted-foreground">
              {accountId}
            </span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-xs text-muted-foreground">Auth provider</span>
            <span className="text-sm text-foreground">Google</span>
          </div>
        </div>
      </Section>

      <OwnedOrgsBilling />

      <Separator />

      <Section
        title="Preferences"
        description="Local preferences for your workspace."
      >
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="mb-3 text-sm font-medium text-foreground">Theme</p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="cursor-pointer"
              variant={theme === "light" ? "default" : "outline"}
              onClick={() => setTheme("light")}
            >
              <Sun className="size-4 mr-1" />
              Light
            </Button>
            <Button
              size="sm"
              className="cursor-pointer"
              variant={theme === "dark" ? "default" : "outline"}
              onClick={() => setTheme("dark")}
            >
              <Moon className="size-4 mr-1" />
              Dark
            </Button>
          </div>
        </div>
      </Section>
    </div>
  );
}

/**
 * Billing is per organization: each org you own with its plan, and a way to
 * its Billing tab, where its owner upgrades or adds seats. Nothing on a
 * self-hosted install, which has no plans.
 */
function OwnedOrgsBilling(): React.JSX.Element | null {
  const owned = useQuery(api.stripe.listOwnedOrgs, {});
  const budget = useQuery(api.account.budget.getForActiveOrg, {});
  const openBilling = useOpenBilling();
  if (!owned || budget?.enforced !== true) return null;

  return (
    <>
      <Separator />
      <Section
        title="Billing"
        description={`Each organization has its own plan, paid by its owner at €${SEAT_PRICE_EUR} per member per month. You own:`}
      >
        <div className="rounded-lg border border-border bg-card">
          {owned.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No organization yet.
            </p>
          )}
          {owned.map((org) => (
            <div
              key={org.orgId}
              className="grid grid-cols-3 items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
            >
              <span className="truncate text-sm text-foreground">
                {org.name}
              </span>
              {org.plan === "pro" ? (
                <Badge variant="success" className="justify-self-start">
                  Pro · {seatCount(org.seats)}
                </Badge>
              ) : (
                <Badge variant="secondary" className="justify-self-start">
                  Free
                </Badge>
              )}
              <Button
                size="xs"
                variant="ghost"
                className="cursor-pointer justify-self-end"
                onClick={() => void openBilling(org.orgId)}
              >
                Billing
                <ArrowRight data-icon="inline-end" />
              </Button>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
