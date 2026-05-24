"use client";

/**
 * Organization settings page: shows the filthy-panty Bearer rotation panel
 * and the org details (rename/delete) panel. Org-scoped, not project-scoped.
 */

import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { ApiAccessPanel } from "./components/ApiAccessPanel";
import { OrgDetailsPanel } from "./components/OrgDetailsPanel";

export default function OrgSettingsPage() {
    const org = useQuery(api.org.getActive, {});

    return (
        <div className="mx-auto w-full max-w-2xl px-8 pt-9 pb-12">
            <div className="pb-6">
                <h2 className="text-xl font-semibold text-foreground">Organization</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                    API access and organization-level settings.
                </p>
            </div>

            {org === undefined ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
            ) : org === null ? (
                <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                    <p className="text-sm text-muted-foreground">
                        You do not have an organization yet.
                    </p>
                </div>
            ) : (
                <div className="grid gap-10">
                    <ApiAccessPanel org={org} />
                    <OrgDetailsPanel org={org} />
                </div>
            )}
        </div>
    );
}
