"use client";

/** Dashboard page with sidebar for monitoring, tracing, tokens usage, and billing. */
import { Button } from "@/app/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
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
    const project = useQuery(api.project.getById, { projectId });
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

    const renderPanel = () => {
        switch (activeTab) {
            case "monitoring":
                return <MonitoringPanel />;
            case "tracing":
                return <TracingPanel />;
            case "tokens":
                return <TokensUsagePanel />;
            case "billing":
                return <BillingPanel />;
            default:
                return <MonitoringPanel />;
        }
    };

    return (
        <div className="flex h-full">
            <aside className="flex w-48 shrink-0 flex-col bg-transparent">
                <div className="px-6 pt-9.25 pb-3">
                    <h2 className="text-lg font-semibold text-foreground">Dashboard</h2>
                </div>
                <nav className="flex flex-col gap-0.5 px-6">
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

            <div className="flex flex-1 flex-col overflow-auto">
                <div className="mx-auto w-full max-w-2xl px-6 py-10">
                    {renderPanel()}
                </div>
            </div>
        </div>
    );
}
