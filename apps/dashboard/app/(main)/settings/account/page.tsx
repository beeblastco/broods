"use client";

/** Account settings page: profile, preferences, and danger zone. */
import { AccountPanel } from "@/app/(main)/[projectId]/settings/components/AccountPanel";
import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Section } from "@/app/components/Section";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

type AccountTab = "profile" | "danger";

const TABS: Array<{ id: AccountTab; label: string; danger?: boolean }> = [
    { id: "profile", label: "Profile" },
    { id: "danger", label: "Danger Zone", danger: true },
];

/** Delete account section rendered inside the Danger Zone tab. */
function AccountDangerPanel() {
    const currentUser = useQuery(api.user.getCurrent);
    const requestAccountDeletion = useMutation(api.user.requestAccountDeletion);
    const router = useRouter();

    const [dialogOpen, setDialogOpen] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [scheduledAt, setScheduledAt] = useState<number | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const effectiveDeletionAt = scheduledAt ?? currentUser?.deletionScheduledFor ?? null;

    async function handleDelete() {
        setIsDeleting(true);
        setDeleteError(null);
        try {
            const result = await requestAccountDeletion({});
            setScheduledAt(result.scheduledFor);
            setDialogOpen(false);
            router.replace("/auth/sign-in");
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : "Unable to schedule account deletion.");
        } finally {
            setIsDeleting(false);
        }
    }

    return (
        <>
            <Section
                title="Delete Account"
                description="Permanently delete your account and all associated data. This schedules deletion after 7 days."
                danger
            >
                <div className="grid gap-4">
                    {effectiveDeletionAt ? (
                        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
                            <p className="text-sm text-foreground">
                                Account deletion scheduled for{" "}
                                <span className="font-medium">
                                    {new Date(effectiveDeletionAt).toLocaleString()}
                                </span>
                                .
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Contact support within 7 days to restore your account if this was accidental.
                            </p>
                        </div>
                    ) : (
                        <div className="flex items-center justify-between gap-6">
                            <div>
                                <p className="text-sm font-medium text-foreground">Delete account</p>
                                <p className="text-xs text-muted-foreground">
                                    Schedules your account for deletion after a 7-day grace period. Your WorkOS identity and all project data will be removed.
                                </p>
                            </div>
                            <Button
                                variant="destructive"
                                size="sm"
                                className="shrink-0 cursor-pointer"
                                onClick={() => {
                                    setDeleteError(null);
                                    setDialogOpen(true);
                                }}
                            >
                                Delete Account
                            </Button>
                        </div>
                    )}
                    {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
                </div>
            </Section>

            <DeleteConfirmDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                resourceName="my account"
                resourceType="account"
                critical={true}
                onConfirm={handleDelete}
                isDeleting={isDeleting}
            />
        </>
    );
}

export default function AccountSettingsPage() {
    const searchParams = useSearchParams();
    const router = useRouter();

    const activeTab = (searchParams.get("tab") as AccountTab) || "profile";
    const activeLabel = TABS.find((t) => t.id === activeTab)?.label ?? "Account";

    return (
        <div className="flex h-full">
            {/* Sidebar */}
            <aside className="flex w-48 shrink-0 flex-col bg-transparent">
                <div className="px-6 pt-9.25 pb-3">
                    <h2 className="text-xl font-semibold text-foreground">Account</h2>
                </div>
                <nav className="flex flex-col gap-0.5 px-3">
                    {TABS.map((tab) => (
                        <Button
                            key={tab.id}
                            variant="ghost"
                            size="sm"
                            className={cn(
                                "w-full justify-start px-3 cursor-pointer",
                                activeTab === tab.id
                                    ? tab.danger
                                        ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                                        : "bg-accent text-foreground"
                                    : tab.danger
                                        ? "text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                            )}
                            onClick={() => {
                                const p = new URLSearchParams(searchParams.toString());
                                p.set("tab", tab.id);
                                router.push(`/settings/account?${p.toString()}`);
                            }}
                        >
                            {tab.label}
                        </Button>
                    ))}
                </nav>
            </aside>

            {/* Content area */}
            <div className="flex flex-1 flex-col overflow-auto">
                <div className="px-8 pt-9.25 pb-6 mx-auto w-full max-w-2xl shrink-0">
                    <h2 className="text-xl font-semibold text-foreground">{activeLabel}</h2>
                </div>
                <div className="mx-auto w-full max-w-2xl px-8 pb-12">
                    {activeTab === "profile" && <AccountPanel />}
                    {activeTab === "danger" && <AccountDangerPanel />}
                </div>
            </div>
        </div>
    );
}
