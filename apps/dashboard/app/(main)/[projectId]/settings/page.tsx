"use client";

/** Settings page with sidebar navigation and panel-based content layout. */
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import type { Id } from "@/convex/_generated/dataModel";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AccountPanel } from "./components/AccountPanel";
import { ApiKeysPanel } from "./components/ApiKeysPanel";
import { DangerPanel } from "./components/DangerPanel";
import { EnvironmentsPanel } from "./components/EnvironmentsPanel";
import { WebhooksPanel } from "./components/WebhooksPanel";

type SettingsTab = "account" | "environments" | "api-keys" | "webhooks" | "danger";

const TABS: Array<{ id: SettingsTab; label: string; danger?: boolean }> = [
    { id: "account", label: "Account" },
    { id: "environments", label: "Environments" },
    { id: "api-keys", label: "API Keys" },
    { id: "webhooks", label: "Webhooks" },
    { id: "danger", label: "Danger Zone", danger: true },
];

export default function SettingsPage() {
    const params = useParams<{ projectId: string }>();
    const searchParams = useSearchParams();
    const projectId = params.projectId as Id<"projects">;
    const router = useRouter();

    const activeTab = (searchParams.get("tab") as SettingsTab) || "account";
    const activeLabel = TABS.find((t) => t.id === activeTab)?.label ?? "Settings";

    const renderPanel = () => {
        switch (activeTab) {
            case "account":
                return <AccountPanel projectId={projectId} />;
            case "environments":
                return <EnvironmentsPanel projectId={projectId} />;
            case "api-keys":
                return <ApiKeysPanel projectId={projectId} />;
            case "webhooks":
                return <WebhooksPanel projectId={projectId} />;
            case "danger":
                return <DangerPanel projectId={projectId} />;
            default:
                return <AccountPanel projectId={projectId} />;
        }
    };

    return (
        <div className="flex h-full">
            {/* Sidebar */}
            <aside className="flex w-48 shrink-0 flex-col bg-transparent">
                <div className="px-6 pt-9.25 pb-3">
                    <h2 className="text-xl font-semibold text-foreground">Settings</h2>
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
                                router.push(`/${projectId}/settings?${p.toString()}`);
                            }}
                        >
                            {tab.label}
                        </Button>
                    ))}
                </nav>
            </aside>

            {/* Content area */}
            <div className="flex flex-1 flex-col overflow-auto">
                {/* Page title — aligned with sidebar header height */}
                <div className="px-8 pt-9.25 pb-6 mx-auto w-full max-w-2xl shrink-0">
                    <h2 className="text-xl font-semibold text-foreground">{activeLabel}</h2>
                </div>
                <div className="mx-auto w-full max-w-2xl px-8 pb-12">
                    {renderPanel()}
                </div>
            </div>
        </div>
    );
}
