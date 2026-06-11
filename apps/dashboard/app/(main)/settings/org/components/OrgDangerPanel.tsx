"use client";

/**
 * Org danger panel: typed-confirm delete that cascades to backend accounts
 * and all filthy-panty data owned by this org.
 */

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
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
    /** The org being deleted. */
    org: Doc<"orgs">;
}

export function OrgDangerPanel({ org }: Props) {
    const router = useRouter();
    const removeOrg = useMutation(api.org.remove);

    const [deleteOpen, setDeleteOpen] = useState(false);
    const [confirmText, setConfirmText] = useState("");
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    async function handleDelete() {
        if (confirmText !== org.slug) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            await removeOrg({ orgId: org._id });
            setDeleteOpen(false);
            router.replace("/");
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : "Delete failed");
            setDeleting(false);
        }
    }

    return (
        <>
            <Section
                title="Delete organization"
                description="Permanently removes this org, its members, and all backend data."
                danger
            >
                <div className="flex items-center justify-between gap-6">
                    <div>
                        <p className="text-sm font-medium text-foreground">Delete organization</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            This deletes the filthy-panty account, agents, conversations, and
                            scheduled jobs. The action cannot be undone.
                        </p>
                    </div>
                    <Button
                        variant="destructive"
                        size="sm"
                        className="cursor-pointer"
                        onClick={() => setDeleteOpen(true)}
                    >
                        Delete
                    </Button>
                </div>
            </Section>

            <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Delete this organization?</DialogTitle>
                        <DialogDescription>
                            All members, agents, conversations, skills, async results, and cron
                            jobs in this org will be permanently removed. Type{" "}
                            <code className="font-mono">{org.slug}</code> to confirm.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-2 py-2">
                        <Input
                            value={confirmText}
                            onChange={(e) => setConfirmText(e.target.value)}
                            placeholder={org.slug}
                            autoComplete="off"
                        />
                        {deleteError && <p className="text-xs text-destructive">{deleteError}</p>}
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            className="cursor-pointer"
                            onClick={() => setDeleteOpen(false)}
                            disabled={deleting}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            className="cursor-pointer disabled:cursor-not-allowed"
                            disabled={confirmText !== org.slug || deleting}
                            onClick={handleDelete}
                        >
                            {deleting ? "Deleting..." : "Delete forever"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
