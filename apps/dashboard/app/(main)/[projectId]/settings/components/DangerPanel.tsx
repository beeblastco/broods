"use client";

/** Danger panel: schedule permanent account deletion with confirmation dialog. */
import { Section } from "@/app/components/Section";
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
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

interface Props {
    /** Project this settings panel belongs to. */
    projectId: Id<"projects">;
}

const DELETE_ACCOUNT_PHRASE = "delete my account";

export function DangerPanel({ projectId: _projectId }: Props) {
    const currentUser = useQuery(api.user.getCurrent);
    const requestAccountDeletion = useMutation(api.user.requestAccountDeletion);

    const [deleteAccountDialogOpen, setDeleteAccountDialogOpen] = useState(false);
    const [deleteAccountPhrase, setDeleteAccountPhrase] = useState("");
    const [isDeletingAccount, setIsDeletingAccount] = useState(false);
    const [scheduledDeletionAt, setScheduledDeletionAt] = useState<number | null>(null);
    const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null);

    const effectiveDeletionAt = scheduledDeletionAt ?? currentUser?.deletionScheduledFor ?? null;

    async function handleDeleteAccount() {
        if (deleteAccountPhrase.trim().toLowerCase() !== DELETE_ACCOUNT_PHRASE) return;
        setIsDeletingAccount(true);
        setDeleteAccountError(null);
        try {
            const result = await requestAccountDeletion({});
            setScheduledDeletionAt(result.scheduledFor);
            setDeleteAccountDialogOpen(false);
            setDeleteAccountPhrase("");
        } catch (error) {
            setDeleteAccountError(error instanceof Error ? error.message : "Unable to schedule account deletion.");
        } finally {
            setIsDeletingAccount(false);
        }
    }

    return (
        <>
            <Section
                title="Delete Account"
                description="Permanently delete your account and all associated data."
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
                                className="shrink-0 cursor-pointer"
                                onClick={() => {
                                    setDeleteAccountError(null);
                                    setDeleteAccountPhrase("");
                                    setDeleteAccountDialogOpen(true);
                                }}
                            >
                                Delete Account
                            </Button>
                        </div>
                    )}
                    {deleteAccountError && <p className="text-sm text-destructive">{deleteAccountError}</p>}
                </div>
            </Section>

            <Dialog open={deleteAccountDialogOpen} onOpenChange={setDeleteAccountDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-destructive">Delete account</DialogTitle>
                        <DialogDescription>
                            This schedules account deletion after 7 days. Type{" "}
                            <span className="font-mono text-foreground">{DELETE_ACCOUNT_PHRASE}</span>{" "}
                            to continue.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-2 py-2">
                        <Label htmlFor="delete-account-confirmation">Confirmation phrase</Label>
                        <Input
                            id="delete-account-confirmation"
                            value={deleteAccountPhrase}
                            onChange={(event) => setDeleteAccountPhrase(event.target.value)}
                            placeholder={DELETE_ACCOUNT_PHRASE}
                            autoFocus
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            className="cursor-pointer"
                            onClick={() => setDeleteAccountDialogOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            className="cursor-pointer"
                            disabled={deleteAccountPhrase.trim().toLowerCase() !== DELETE_ACCOUNT_PHRASE || isDeletingAccount}
                            onClick={handleDeleteAccount}
                        >
                            {isDeletingAccount ? "Scheduling..." : "Schedule deletion"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
