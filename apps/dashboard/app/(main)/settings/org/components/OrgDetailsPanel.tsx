"use client";

/**
 * Org details panel: edit org name, view plan, and delete the org. Delete is
 * a typed-confirm action that cascades to backend accounts + filthy-panty data.
 */

import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
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
import type { Doc } from "@/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
    /** The org being edited. */
    org: Doc<"orgs">;
}

export function OrgDetailsPanel({ org }: Props) {
    const router = useRouter();
    const updateOrg = useMutation(api.org.update);
    const removeOrg = useMutation(api.org.remove);

    const [name, setName] = useState(org.name);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saveNotice, setSaveNotice] = useState<string | null>(null);

    const [deleteOpen, setDeleteOpen] = useState(false);
    const [confirmText, setConfirmText] = useState("");
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const dirty = name.trim() !== org.name && name.trim().length > 0;

    async function handleSave() {
        if (!dirty) return;
        setSaving(true);
        setSaveError(null);
        setSaveNotice(null);
        try {
            await updateOrg({ orgId: org._id, name: name.trim() });
            setSaveNotice("Saved.");
        } catch (err) {
            setSaveError(err instanceof Error ? err.message : "Save failed");
        } finally {
            setSaving(false);
        }
    }

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
            <Section title="Organization details" description="Rename or delete this organization.">
                <div className="grid gap-4">
                    <div className="grid gap-1">
                        <Label htmlFor="org-name" className="text-xs text-muted-foreground">Name</Label>
                        <div className="flex items-center gap-2">
                            <Input
                                id="org-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="flex-1"
                            />
                            <Button
                                size="sm"
                                className="cursor-pointer disabled:cursor-not-allowed"
                                disabled={!dirty || saving}
                                onClick={handleSave}
                            >
                                {saving ? "Saving..." : "Save"}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Slug: <code className="font-mono">{org.slug}</code>
                        </p>
                        {saveError && <p className="text-xs text-destructive">{saveError}</p>}
                        {saveNotice && <p className="text-xs text-muted-foreground">{saveNotice}</p>}
                    </div>

                    <div className="grid gap-1">
                        <Label className="text-xs text-muted-foreground">Plan</Label>
                        <div>
                            <Badge variant="secondary" className="text-xs uppercase">
                                {org.plan}
                            </Badge>
                        </div>
                    </div>
                </div>
            </Section>

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
