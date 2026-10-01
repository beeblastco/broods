"use client";

import { useStage } from "@/app/hooks/useStage";
import { pickTab, SETTINGS_TABS } from "@/app/lib/navigation";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useParams, useSearchParams } from "next/navigation";
import { DangerPanel } from "./components/DangerPanel";
import { DeployKeysPanel } from "./components/DeployKeysPanel";
import { EnvironmentVariablesPanel } from "./components/EnvironmentVariablesPanel";
import { PoliciesPanel } from "./components/PoliciesPanel";
import { ProjectGeneralPanel } from "./components/ProjectGeneralPanel";
import { WebhooksPanel } from "./components/WebhooksPanel";

export default function SettingsPage(): React.JSX.Element {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId as Id<"projects">;
  const { stageId: activeStageId } = useStage();

  const tab = pickTab(SETTINGS_TABS, searchParams.get("tab"));

  const renderPanel = (): React.JSX.Element => {
    switch (tab.id) {
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
    <div className="flex h-full min-w-0 flex-col overflow-auto">
      <h1 className="sr-only">{tab.label}</h1>
      <div className="mx-auto w-full max-w-2xl px-6 pt-6 pb-12">
        {renderPanel()}
      </div>
    </div>
  );
}
