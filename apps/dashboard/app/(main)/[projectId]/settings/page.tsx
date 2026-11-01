"use client";

import { useStage } from "@/app/hooks/useStage";
import { pickTab, SETTINGS_TABS } from "@/app/lib/navigation";
import { cn } from "@/app/lib/utils";
import type { Id } from "@broods/convex/_generated/dataModel";
import dynamic from "next/dynamic";
import { useParams, useSearchParams } from "next/navigation";
import { ProjectGeneralPanel } from "./components/ProjectGeneralPanel";
import {
  loadDangerPanel,
  loadEnvironmentVariablesPanel,
  loadKeysPanel,
  loadPoliciesPanel,
  loadWebhooksPanel,
} from "./panels";

/** The line a panel shows while it queries, held while its chunk loads. */
function PanelLoading(): React.JSX.Element {
  return <p className="text-sm text-muted-foreground">Loading…</p>;
}

// General is the default tab and ships with the page; the others load the
// first time they are opened. Each passes `loading`, which is what gives it a
// Suspense boundary of its own: without one its download suspends up to the
// route's loading.tsx. The option object is spelled out at each call:
// Turbopack reads it statically.
const EnvironmentVariablesPanel = dynamic(loadEnvironmentVariablesPanel, {
  loading: PanelLoading,
});
const KeysPanel = dynamic(loadKeysPanel, { loading: PanelLoading });
const WebhooksPanel = dynamic(loadWebhooksPanel, { loading: PanelLoading });
const PoliciesPanel = dynamic(loadPoliciesPanel, { loading: PanelLoading });
const DangerPanel = dynamic(loadDangerPanel, { loading: PanelLoading });

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
      case "keys":
        return <KeysPanel projectId={projectId} stageId={activeStageId} />;
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
      <div
        className={cn(
          "mx-auto w-full px-6 pt-6 pb-12",
          tab.id === "keys" ? "max-w-6xl" : "max-w-2xl",
        )}
      >
        {renderPanel()}
      </div>
    </div>
  );
}
