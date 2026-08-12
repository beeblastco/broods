"use client";

/** Settings page with sidebar navigation and panel-based content layout. */
import { Button } from "@/app/components/ui/button";
import { useStage } from "@/app/hooks/useStage";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { DangerPanel } from "./components/DangerPanel";
import { DeployKeysPanel } from "./components/DeployKeysPanel";
import { EnvironmentVariablesPanel } from "./components/EnvironmentVariablesPanel";
import { PoliciesPanel } from "./components/PoliciesPanel";
import { ProjectGeneralPanel } from "./components/ProjectGeneralPanel";
import { WebhooksPanel } from "./components/WebhooksPanel";

type SettingsTab =
  "general" | "variables" | "deploy" | "webhooks" | "policies" | "danger";

const TABS: Array<{ id: SettingsTab; label: string; danger?: boolean }> = [
  { id: "general", label: "General" },
  { id: "variables", label: "Environment variables" },
  { id: "deploy", label: "Deploy" },
  { id: "webhooks", label: "Webhooks" },
  { id: "policies", label: "Policies" },
  { id: "danger", label: "Danger Zone", danger: true },
];

export default function SettingsPage() {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId as Id<"projects">;
  const { stageId } = useStage();

  // Build a tab href that preserves the current params (e.g. ?stage=) so the link is shareable
  // and can be opened in a new browser tab.
  const tabHref = (tabId: SettingsTab) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", tabId);

    return `/${projectId}/settings?${next.toString()}`;
  };

  const stages = useQuery(api.stage.list, {
    projectId: projectId,
  }) as Doc<"stages">[] | undefined;
  // Resolve the stage to configure: the URL selection, else the default, else the first.
  const activeStage =
    stages?.find((stage) => stage._id === stageId) ??
    stages?.find((stage) => stage.isDefault) ??
    stages?.[0] ??
    null;
  const activeStageId = activeStage?._id ?? null;

  const activeTab = (searchParams.get("tab") as SettingsTab) || "general";
  const tab = TABS.find((t) => t.id === activeTab);
  const activeLabel = tab?.label ?? "Settings";

  const renderPanel = () => {
    switch (activeTab) {
      case "general":
        return <ProjectGeneralPanel projectId={projectId} />;
      case "variables":
        return (
          <EnvironmentVariablesPanel
            projectId={projectId}
            stageId={activeStageId}
          />
        );
      case "deploy":
        return (
          <DeployKeysPanel projectId={projectId} stageId={activeStageId} />
        );
      case "webhooks":
        return <WebhooksPanel projectId={projectId} stageId={activeStageId} />;
      case "policies":
        return <PoliciesPanel projectId={projectId} stageId={activeStageId} />;
      case "danger":
        return <DangerPanel projectId={projectId} stageId={activeStageId} />;
      default:
        return <ProjectGeneralPanel projectId={projectId} />;
    }
  };

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col bg-transparent">
        <div className="px-6 pt-9.25 pb-3">
          <h2 className="text-xl font-semibold text-foreground">Settings</h2>
        </div>
        <nav className="flex flex-col gap-4 px-3">
          {/* Base settings group */}
          <div className="flex flex-col gap-0.5">
            {TABS.filter((t) => !t.danger).map((t) => (
              <Button
                key={t.id}
                nativeButton={false}
                render={<Link href={tabHref(t.id)} />}
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full select-none justify-start px-3 cursor-pointer active:bg-accent/70 h-8",
                  activeTab === t.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {t.label}
              </Button>
            ))}
          </div>

          {/* Danger zone group */}
          <div className="flex flex-col gap-0.5">
            {TABS.filter((t) => t.id === "danger").map((t) => (
              <Button
                key={t.id}
                nativeButton={false}
                render={<Link href={tabHref(t.id)} />}
                variant="ghost"
                size="sm"
                className={cn(
                  "w-full select-none justify-start px-3 cursor-pointer active:bg-accent/70 h-8",
                  activeTab === t.id
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/20"
                    : "text-destructive/70 hover:text-destructive hover:bg-destructive/10 active:bg-destructive/10",
                )}
              >
                {t.label}
              </Button>
            ))}
          </div>
        </nav>
      </aside>

      {/* Content area — min-w-0 lets long values truncate instead of widening the column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-auto">
        {/* Page title — aligned with sidebar header height */}
        <div className="px-6 pt-9.25 pb-6 mx-auto w-full max-w-2xl shrink-0">
          <h2 className="text-xl font-semibold text-foreground">
            {activeLabel}
          </h2>
        </div>
        <div className="mx-auto w-full max-w-2xl px-6 pb-12">
          {renderPanel()}
        </div>
      </div>
    </div>
  );
}
