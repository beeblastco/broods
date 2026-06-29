"use client";

/**
 * Organization settings page with sidebar navigation matching the project
 * settings + dashboard layout. Tabs: General, API Access, Members, Danger Zone.
 */

import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import { useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApiAccessPanel } from "./components/ApiAccessPanel";
import { MembersPanel } from "./components/MembersPanel";
import { OrgDangerPanel } from "./components/OrgDangerPanel";
import { OrgGeneralPanel } from "./components/OrgGeneralPanel";

type OrgTab = "general" | "api-access" | "members" | "danger";

const TABS: Array<{ id: OrgTab; label: string; danger?: boolean }> = [
    { id: "general", label: "General" },
    { id: "api-access", label: "API Access" },
    { id: "members", label: "Members" },
    { id: "danger", label: "Danger Zone", danger: true },
];

export default function OrgSettingsPage() {
    const org = useQuery(api.org.getActive, {});
    const searchParams = useSearchParams();
    const router = useRouter();

    const activeTab = (searchParams.get("tab") as OrgTab) || "general";
    const activeLabel = TABS.find((t) => t.id === activeTab)?.label ?? "Organization";

    const renderPanel = () => {
        if (!org) return null;
        switch (activeTab) {
            case "general":
                return <OrgGeneralPanel org={org} />;
            case "api-access":
                return <ApiAccessPanel org={org} />;
            case "members":
                return <MembersPanel org={org} />;
            case "danger":
                return <OrgDangerPanel org={org} />;
            default:
                return <OrgGeneralPanel org={org} />;
        }
    };

    return (
        <div className="flex h-full">
            {/* Sidebar */}
            <aside className="flex w-48 shrink-0 flex-col bg-transparent">
                <div className="px-6 pt-9.25 pb-3">
                    <h2 className="text-xl font-semibold text-foreground">Organization</h2>
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
                                router.push(`/settings/org?${p.toString()}`);
                            }}
                        >
                            {tab.label}
                        </Button>
                    ))}
                </nav>
            </aside>

            {/* Content area */}
            <div className="flex flex-1 flex-col overflow-auto">
                <div className="px-6 pt-9.25 pb-6 mx-auto w-full max-w-2xl shrink-0">
                    <h2 className="text-xl font-semibold text-foreground">{activeLabel}</h2>
                </div>
                <div className="mx-auto w-full max-w-2xl px-6 pb-12">
                    {org === undefined ? (
                        <p className="text-sm text-muted-foreground">Loading...</p>
                    ) : org === null ? (
                        <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                            <p className="text-sm text-muted-foreground">
                                You do not have an organization yet.
                            </p>
                        </div>
                    ) : (
                        renderPanel()
                    )}
                </div>
            </div>
        </div>
    );
}
