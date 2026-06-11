"use client";

/** Account panel: profile, avatar, account overview, and preferences. */
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
import { api } from "@filthy-panty/convex/_generated/api";
import type { ConfiguredPlanTier, PlanTier } from "@/app/lib/pricing";
import {
  isMaxPlan,
  PLAN_CONFIGS,
  resolvePlan,
  UPGRADE_URL,
} from "@/app/lib/pricing";
import { cn } from "@/app/lib/utils";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useMutation, useQuery } from "convex/react";
import { ArrowUpRight, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";

const HANDLE_REGEX = /^[a-z0-9_-]{3,32}$/;

/** User profile, avatar, account overview, and theme preferences. */
export function AccountPanel() {
  const { theme, setTheme } = useTheme();
  const { user: authUser } = useAuth();

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
  const userPlan: ConfiguredPlanTier = resolvePlan(
    currentUser?.plan as PlanTier | undefined,
  );
  const planConfig = PLAN_CONFIGS[userPlan];
  const showUpgrade = !isMaxPlan(userPlan);

  async function handleSaveProfile() {
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
      setSaveError(
        error instanceof Error
          ? error.message
          : "Unable to save account settings.",
      );
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
        title="Account Overview"
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
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">Auth provider</span>
            <span className="text-sm text-foreground">Google via WorkOS</span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-xs text-muted-foreground">Plan</span>
            <div className="flex items-center gap-2">
              <Badge className={planConfig.badgeClass}>
                {planConfig.label}
              </Badge>
              {showUpgrade && (
                <Button size="xs" asChild>
                  <a
                    href={UPGRADE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Upgrade
                    <ArrowUpRight className="size-3" />
                  </a>
                </Button>
              )}
            </div>
          </div>
        </div>
      </Section>

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
