"use client";

import { Button } from "@/app/components/ui/button";
import { useStage } from "@/app/hooks/useStage";
import type { Id } from "@broods/convex/_generated/dataModel";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { DangerPanel } from "./components/DangerPanel";
import { DeployKeysPanel } from "./components/DeployKeysPanel";
import { EnvironmentVariablesPanel } from "./components/EnvironmentVariablesPanel";
import { PoliciesPanel } from "./components/PoliciesPanel";
import { ProjectGeneralPanel } from "./components/ProjectGeneralPanel";
import { WebhooksPanel } from "./components/WebhooksPanel";

type SettingsTab =
  | "general"
  | "variables"
  | "deploy"
  | "webhooks"
  | "policies"
  | "danger";

const TABS: Array<{ id: SettingsTab; label: string; danger?: boolean }> = [
  { id: "general", label: "General" },
  { id: "variables", label: "Environment variables" },
  { id: "deploy", label: "Deploy" },
  { id: "webhooks", label: "Webhooks" },
  { id: "policies", label: "Policies" },
  { id: "danger", label: "Danger Zone", danger: true },
];

export default function SettingsPage(): React.JSX.Element {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId as Id<"projects">;
  const { stageId: activeStageId } = useStage();

  // Carries the current params (e.g. ?stage=) so the link survives a share or a
  // middle-click into a new browser tab.
  const tabHref = (tabId: SettingsTab): string => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", tabId);

    return `/${projectId}/settings?${next.toString()}`;
  };

  const activeTab = (searchParams.get("tab") as SettingsTab) || "general";
  const tab = TABS.find((t) => t.id === activeTab);
  const activeLabel = tab?.label ?? "Settings";

  const renderPanel = (): React.JSX.Element => {
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
      <aside className="flex w-56 shrink-0 flex-col bg-transparent">
        <div className="px-6 pt-9.25 pb-3">
          <h2 className="text-xl font-semibold text-foreground">Settings</h2>
        </div>
        <nav className="flex flex-col gap-4 px-3">
          <div className="flex flex-col gap-0.5">
            {TABS.filter((t) => !t.danger).map((t) => (
              <Button
                key={t.id}
                nativeButton={false}
                render={<Link href={tabHref(t.id)} draggable={false} />}
                variant="nav"
                size="sm"
                data-active={activeTab === t.id}
                className="w-full select-none justify-start cursor-pointer"
              >
                {t.label}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-0.5">
            {TABS.filter((t) => t.id === "danger").map((t) => (
              <Button
                key={t.id}
                nativeButton={false}
                render={<Link href={tabHref(t.id)} draggable={false} />}
                variant="nav-destructive"
                size="sm"
                data-active={activeTab === t.id}
                className="w-full select-none justify-start cursor-pointer"
              >
                {t.label}
              </Button>
            ))}
          </div>
        </nav>
      </aside>

      {/* min-w-0 lets long values truncate instead of widening the column */}
      <div className="flex min-w-0 flex-1 flex-col overflow-auto">
        {/* Page title, aligned with sidebar header height */}
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
