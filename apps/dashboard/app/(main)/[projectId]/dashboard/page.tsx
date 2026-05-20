"use client";

/** Dashboard page with sidebar navigation and a titled content panel. */
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { BillingPanel } from "./components/BillingPanel";
import { MonitoringPanel } from "./components/MonitoringPanel";
import { TokensUsagePanel } from "./components/TokensUsagePanel";
import { TracingPanel } from "./components/TracingPanel";

const TABS = [
    { id: "monitoring", label: "Monitoring" },
    { id: "tracing", label: "Tracing" },
    { id: "tokens", label: "Tokens Usage" },
    { id: "billing", label: "Billing & Plan" },
] as const;

type DashboardTab = (typeof TABS)[number]["id"];

export default function DashboardPage() {
    const params = useParams<{ projectId: string }>();
    const projectId = params.projectId as Id<"projects">;
    const project = useQuery(api.project.getById, { projectId: projectId });
    const [activeTab, setActiveTab] = useState<DashboardTab>("monitoring");

    if (project === undefined) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">Loading…</p>
            </div>
        );
    }

    if (project === null) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">Project not found.</p>
            </div>
        );
    }

    const activeLabel = TABS.find((t) => t.id === activeTab)?.label ?? "";

    const renderPanel = () => {
        switch (activeTab) {
            case "monitoring":
                return <MonitoringPanel projectId={projectId} />;
            case "tracing":
                return <TracingPanel />;
            case "tokens":
                return <TokensUsagePanel projectId={projectId} />;
            case "billing":
                return <BillingPanel projectId={projectId} />;
            default:
                return <MonitoringPanel projectId={projectId} />;
        }
    };

    return (
        <div className="flex h-full">
            {/* Sidebar */}
            <aside className="flex w-48 shrink-0 flex-col bg-transparent">
                <div className="px-6 pt-9.25 pb-3">
                    <h2 className="text-xl font-semibold text-foreground">Dashboard</h2>
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
                                    ? "bg-accent text-foreground"
                                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                            )}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            {tab.label}
                        </Button>
                    ))}
                </nav>
            </aside>

            {/* Content area */}
            <div className="flex flex-1 flex-col overflow-auto">
                {/* Page title — aligned with sidebar header height */}
                <div className="px-8 pt-9.25 pb-5 mx-auto w-full max-w-2xl shrink-0">
                    <h2 className="text-xl font-semibold text-foreground">{activeLabel}</h2>
                </div>
                <div className="mx-auto w-full max-w-2xl px-8 pb-12">
                    {renderPanel()}
                </div>
            </div>
        </div>
    );
}
