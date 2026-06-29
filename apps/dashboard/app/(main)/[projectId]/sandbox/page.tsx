"use client";

/**
 * Sandbox tab. Left side-nav (matching settings) switches between the active org's
 * live instances, their snapshots/images, and the read-only Security/Networking
 * policy posture. Instances are mirrored from broods's runtime into Convex;
 * suspend/resume/terminate/snapshot go through Convex actions that proxy to
 * broods's /accounts/me/sandboxes endpoints.
 */

import { useEnvironment } from "@/app/hooks/useEnvironment";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { SandboxInstancesTable } from "./components/SandboxInstancesTable";
import { SandboxPolicyTable } from "./components/SandboxPolicyTable";
import { SandboxSnapshotsTable } from "./components/SandboxSnapshotsTable";

type SandboxView = "instances" | "snapshots" | "security" | "networking";

const VIEWS: Array<{ id: SandboxView; label: string }> = [
    { id: "instances", label: "Instances" },
    { id: "snapshots", label: "Snapshots" },
    { id: "security", label: "Security" },
    { id: "networking", label: "Networking" },
];

export default function SandboxPage() {
    const params = useParams<{ projectId: string }>();
    const projectId = params.projectId as Id<"projects">;
    const { environmentId } = useEnvironment();
    const environments = useQuery(api.environment.list, { projectId: projectId }) as Doc<"environments">[] | undefined;
    const activeEnv =
        environments?.find((env) => env._id === environmentId) ??
        environments?.find((env) => env.isDefault) ??
        environments?.[0] ??
        null;
    const activeEnvId = activeEnv?._id ?? null;
    const instances = useQuery(
        api.sandboxInstances.listForActiveOrg,
        activeEnvId ? { projectId: projectId, environmentId: activeEnvId } : "skip",
    );
    const snapshots = useQuery(api.sandboxSnapshots.listForActiveOrg, {});
    const account = useQuery(api.org.getActiveAccount, {});

    const [view, setView] = useState<SandboxView>("instances");
    const activeLabel = VIEWS.find((tab) => tab.id === view)?.label ?? "Sandboxes";

    const loading = environments === undefined || instances === undefined || snapshots === undefined || account === undefined;

    return (
        <div className="flex h-full">
            {/* Sidebar */}
            <aside className="flex w-48 shrink-0 flex-col bg-transparent">
                <div className="px-6 pt-9.25 pb-3">
                    <h2 className="text-xl font-semibold text-foreground">Sandboxes</h2>
                </div>
                <nav className="flex flex-col gap-0.5 px-3">
                    {VIEWS.map((tab) => (
                        <Button
                            key={tab.id}
                            variant="ghost"
                            size="sm"
                            className={cn(
                                "w-full justify-start px-3 cursor-pointer",
                                view === tab.id
                                    ? "bg-accent text-foreground"
                                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                            )}
                            onClick={() => setView(tab.id)}
                        >
                            {tab.label}
                        </Button>
                    ))}
                </nav>
            </aside>

            {/* Content area */}
            <div className="flex min-w-0 flex-1 flex-col overflow-auto">
                <div className="px-6 pt-9.25 pb-5 mx-auto w-full max-w-7xl shrink-0">
                    <h2 className="text-xl font-semibold text-foreground">{activeLabel}</h2>
                </div>
                <div className="flex flex-col gap-3 mx-auto w-full max-w-7xl px-6 pb-12">
                    <p className="shrink-0 text-xs text-muted-foreground">
                        Live persistent sandbox instances and their snapshots. broods owns the
                        runtime; the dashboard drives suspend, resume, terminate, and snapshot.
                    </p>
                    {loading ? (
                        <p className="text-sm text-muted-foreground">Loading...</p>
                    ) : !account ? (
                        <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                            <p className="text-sm text-muted-foreground">
                                Your organization is not provisioned yet. Provision the broods
                                account in settings before using sandboxes.
                            </p>
                        </div>
                    ) : view === "instances" ? (
                        <SandboxInstancesTable instances={instances} />
                    ) : view === "snapshots" ? (
                        <SandboxSnapshotsTable snapshots={snapshots} />
                    ) : view === "security" ? (
                        <SandboxPolicyTable instances={instances} dimension="security" />
                    ) : (
                        <SandboxPolicyTable instances={instances} dimension="networking" />
                    )}
                </div>
            </div>
        </div>
    );
}
