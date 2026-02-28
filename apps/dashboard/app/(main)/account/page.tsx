"use client";

/** Account settings for profile, preferences, and account lifecycle actions. */
import { useEffect, useRef, useState } from "react";
import { useShooAuth } from "@shoojs/react";
import { useMutation, useQuery } from "convex/react";
import { useTheme } from "next-themes";
import { api } from "@/convex/_generated/api";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolvePlan, isMaxPlan, PLAN_CONFIGS, UPGRADE_URL } from "@/lib/pricing";
import type { PlanTier } from "@/lib/pricing";
import { Section } from "@/app/components/Section";
import { Avatar, AvatarFallback, AvatarImage } from "@/app/components/ui/avatar";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { Separator } from "@/app/components/ui/separator";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/app/components/ui/dialog";

const DELETE_CONFIRM_PHRASE = "delete my account";
const HANDLE_REGEX = /^[a-z0-9_-]{3,32}$/;

export default function AccountSettingsPage() {
    const { identity, claims } = useShooAuth();
    const { theme, setTheme } = useTheme();
    const currentUser = useQuery(api.user.getCurrent);
    const updateProfile = useMutation(api.user.updateProfile);
    const requestAccountDeletion = useMutation(api.user.requestAccountDeletion);

    const claimName = typeof claims?.name === "string" ? claims.name : "User";
    const claimEmail = typeof claims?.email === "string" ? claims.email : "Not available";
    const claimAvatar = typeof claims?.picture === "string" ? claims.picture : null;
    const claimNameRef = useRef(claimName);
    claimNameRef.current = claimName;

    const [name, setName] = useState("");
    const [accountHandle, setAccountHandle] = useState("");
    const [savedProfile, setSavedProfile] = useState<{ name: string; accountHandle: string } | null>(null);
    const [isDirty, setIsDirty] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saveNotice, setSaveNotice] = useState<string | null>(null);

    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [deletePhrase, setDeletePhrase] = useState("");
    const [isDeleting, setIsDeleting] = useState(false);
    const [scheduledDeletionAt, setScheduledDeletionAt] = useState<number | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    useEffect(() => {
        if (currentUser === undefined || isDirty) {
            return;
        }

        const nextName = currentUser?.name ?? claimNameRef.current;
        const nextHandle = currentUser?.accountHandle ?? "";
        setName(nextName);
        setAccountHandle(nextHandle);
        setSavedProfile({
            name: nextName.trim(),
            accountHandle: nextHandle.trim().toLowerCase(),
        });
        setScheduledDeletionAt(currentUser?.deletionScheduledFor ?? null);
    }, [currentUser, isDirty]);

    const normalizedHandle = accountHandle.trim().toLowerCase();
    const hasHandleError =
        normalizedHandle.length > 0 && !HANDLE_REGEX.test(normalizedHandle);
    const hasChanges =
        savedProfile !== null &&
        (name.trim() !== savedProfile.name ||
            normalizedHandle !== savedProfile.accountHandle);
    const avatarUrl = currentUser?.avatarUrl ?? claimAvatar;
    const accountId = currentUser?._id ?? identity.userId;
    const email = currentUser?.email ?? claimEmail;
    const userPlan: PlanTier = resolvePlan(currentUser?.plan as PlanTier | undefined);
    const planConfig = PLAN_CONFIGS[userPlan];
    const showUpgrade = !isMaxPlan(userPlan);
    const effectiveDeletionAt = scheduledDeletionAt ?? currentUser?.deletionScheduledFor ?? null;

    async function handleSaveProfile() {
        const trimmedName = name.trim();
        if (!trimmedName) {
            setSaveError("Display name is required.");
            return;
        }

        if (hasHandleError) {
            setSaveError("Account handle must be 3-32 chars and use a-z, 0-9, '_' or '-'.");
            return;
        }

        setIsSaving(true);
        setSaveError(null);
        setSaveNotice(null);

        try {
            await updateProfile({
                name: trimmedName,
                accountHandle: normalizedHandle || undefined,
            });

            setName(trimmedName);
            setAccountHandle(normalizedHandle);
            setSavedProfile({
                name: trimmedName,
                accountHandle: normalizedHandle,
            });
            setIsDirty(false);
            setSaveNotice("Changes saved.");
        } catch (error) {
            setSaveError(
                error instanceof Error
                    ? error.message
                    : "Unable to save account settings.",
            );
        } finally {
            setIsSaving(false);
        }
    }

    async function handleDeleteAccount() {
        if (deletePhrase.trim().toLowerCase() !== DELETE_CONFIRM_PHRASE) {
            return;
        }

        setIsDeleting(true);
        setDeleteError(null);

        try {
            const result = await requestAccountDeletion({});
            setScheduledDeletionAt(result.scheduledFor);
            setDeleteDialogOpen(false);
            setDeletePhrase("");
        } catch (error) {
            setDeleteError(
                error instanceof Error
                    ? error.message
                    : "Unable to schedule account deletion.",
            );
        } finally {
            setIsDeleting(false);
        }
    }

    if (!identity.userId || currentUser === undefined) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-2xl px-6 py-10">
            <h1 className="mb-2 text-xl font-semibold text-foreground">Account Settings</h1>
            <p className="mb-8 text-sm text-muted-foreground">
                Update your account attributes, preferences, and lifecycle settings.
            </p>

            <div className="grid gap-8">
                <Section title="Profile" description="Editable attributes for your account.">
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
                            <p className={cn("text-xs", hasHandleError ? "text-destructive" : "text-muted-foreground")}>
                                {hasHandleError
                                    ? "Use 3-32 chars: lowercase letters, numbers, '_' or '-'."
                                    : "Public identifier shown as @handle."}
                            </p>
                        </div>

                        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
                            <p className="text-xs text-muted-foreground">
                                {hasChanges ? "You have unsaved changes." : saveNotice ?? "All changes saved."}
                            </p>
                            <Button
                                size="sm"
                                onClick={handleSaveProfile}
                                disabled={!hasChanges || hasHandleError || !name.trim() || isSaving}
                            >
                                {isSaving ? "Saving..." : "Save changes"}
                            </Button>
                        </div>
                        {saveError && <p className="text-sm text-destructive">{saveError}</p>}
                    </div>
                </Section>

                <Separator />

                <Section title="Avatar" description="Preview from your identity provider.">
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

                <Section title="Account Overview" description="Read-only account details.">
                    <div className="rounded-lg border border-border bg-card">
                        <div className="flex items-center justify-between border-b border-border px-4 py-3">
                            <span className="text-xs text-muted-foreground">Email</span>
                            <span className="text-sm text-foreground">{email}</span>
                        </div>
                        <div className="flex items-center justify-between border-b border-border px-4 py-3">
                            <span className="text-xs text-muted-foreground">Account ID</span>
                            <span className="font-mono text-xs text-muted-foreground">{accountId}</span>
                        </div>
                        <div className="flex items-center justify-between border-b border-border px-4 py-3">
                            <span className="text-xs text-muted-foreground">Auth provider</span>
                            <span className="text-sm text-foreground">Google via Shoo</span>
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

                <Section title="Preferences" description="Local preferences for your workspace.">
                    <div className="rounded-lg border border-border bg-card p-4">
                        <p className="mb-3 text-sm font-medium text-foreground">Theme</p>
                        <div className="flex items-center gap-2">
                            <Button
                                size="sm"
                                variant={theme === "light" ? "default" : "outline"}
                                onClick={() => setTheme("light")}
                            >
                                Light
                            </Button>
                            <Button
                                size="sm"
                                variant={theme === "dark" ? "default" : "outline"}
                                onClick={() => setTheme("dark")}
                            >
                                Dark
                            </Button>
                        </div>
                    </div>
                </Section>

                <Separator />

                <Section
                    title="Danger Zone"
                    description="Delete your account with a 7-day recovery buffer."
                    danger
                >
                    <div className="grid gap-4">
                        {effectiveDeletionAt ? (
                            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
                                <p className="text-sm text-foreground">
                                    Account deletion is scheduled for{" "}
                                    <span className="font-medium">
                                        {new Date(effectiveDeletionAt).toLocaleString()}
                                    </span>
                                    .
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Your account is not deleted yet. If this was accidental, contact support within 7 days to restore it.
                                </p>
                            </div>
                        ) : (
                            <div className="flex items-center justify-between gap-6">
                                <div>
                                    <p className="text-sm font-medium text-foreground">Delete account</p>
                                    <p className="text-xs text-muted-foreground">
                                        Deletion is delayed for 7 days. During that window, support can restore your account if needed.
                                    </p>
                                </div>
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    className="shrink-0"
                                    onClick={() => {
                                        setDeleteError(null);
                                        setDeletePhrase("");
                                        setDeleteDialogOpen(true);
                                    }}
                                >
                                    Delete Account
                                </Button>
                            </div>
                        )}
                        {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
                    </div>
                </Section>
            </div>

            <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-destructive">Delete account</DialogTitle>
                        <DialogDescription>
                            This schedules account deletion after 7 days. Type{" "}
                            <span className="font-mono text-foreground">{DELETE_CONFIRM_PHRASE}</span>{" "}
                            to continue.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-2 py-2">
                        <Label htmlFor="delete-account-confirmation">Confirmation phrase</Label>
                        <Input
                            id="delete-account-confirmation"
                            value={deletePhrase}
                            onChange={(event) => setDeletePhrase(event.target.value)}
                            placeholder={DELETE_CONFIRM_PHRASE}
                            autoFocus
                        />
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setDeleteDialogOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            disabled={
                                deletePhrase.trim().toLowerCase() !== DELETE_CONFIRM_PHRASE || isDeleting
                            }
                            onClick={handleDeleteAccount}
                        >
                            {isDeleting ? "Scheduling..." : "Schedule deletion"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
