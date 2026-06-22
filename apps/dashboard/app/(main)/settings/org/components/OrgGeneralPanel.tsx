"use client";

/**
 * Org general settings: rename the organization and view its slug + plan.
 * Danger actions (delete) live in OrgDangerPanel.
 */

import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { api } from "@broods/convex/_generated/api";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useState } from "react";

interface Props {
    /** The org being edited. */
    org: Doc<"orgs">;
}

export function OrgGeneralPanel({ org }: Props) {
    const updateOrg = useMutation(api.org.update).withOptimisticUpdate((localStore, args) => {
        const active = localStore.getQuery(api.org.getActive, {});
        if (active && active._id === args.orgId && args.name !== undefined) {
            localStore.setQuery(api.org.getActive, {}, { ...active, name: args.name });
        }
    });

    const [name, setName] = useState(org.name);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saveNotice, setSaveNotice] = useState<string | null>(null);

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

    return (
        <Section title="Organization details" description="Rename this organization or review its plan.">
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
    );
}
