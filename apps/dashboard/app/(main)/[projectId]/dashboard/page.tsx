"use client";

import { useEverTrue } from "@/app/hooks/useEverTrue";
import { useStage } from "@/app/hooks/useStage";
import { useStageSession } from "@/app/hooks/useStageSession";
import { DASHBOARD_TABS, pickTab } from "@/app/lib/navigation";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import dynamic from "next/dynamic";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { MonitoringPanel } from "./components/MonitoringPanel";
import { ObservabilityKeyPrompt } from "./components/ObservabilityKeyPrompt";
import DashboardLoading from "./loading";
import {
  DASHBOARD_PANELS,
  loadBillingPanel,
  loadRuntimeKeyDialog,
  loadRuntimeKeyView,
  loadTokensUsagePanel,
  loadTracingPanel,
} from "./panels";
import { toErrorMessage } from "@/app/lib/errors";

function ObservabilityLoading(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-64 items-center justify-center">
      <p className="text-sm text-muted-foreground">Loading…</p>
    </div>
  );
}

function ColumnLoading(): React.JSX.Element {
  return <p className="text-sm text-muted-foreground">Loading…</p>;
}

// `loading` gives each its own Suspense boundary instead of the route's loading.tsx.
// Turbopack reads the options statically, so each call spells them out.
const TracingPanel = dynamic(loadTracingPanel, {
  loading: ObservabilityLoading,
});
const TokensUsagePanel = dynamic(loadTokensUsagePanel, {
  loading: ColumnLoading,
});
const BillingPanel = dynamic(loadBillingPanel, { loading: ColumnLoading });
const RuntimeKeyView = dynamic(loadRuntimeKeyView, { loading: ColumnLoading });
const RuntimeKeyDialog = dynamic(loadRuntimeKeyDialog, {
  loading: (): null => null,
});

export default function DashboardPage(): React.JSX.Element {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId as Id<"projects">;
  // The list, not a get: the header's subscription answers it from cache on navigation.
  const projects = useQuery(api.project.list, {});
  const project =
    projects === undefined
      ? undefined
      : (projects.find((candidate) => candidate._id === projectId) ?? null);
  const { stageId: activeStageId } = useStage();
  const tab = pickTab(DASHBOARD_TABS, searchParams.get("tab"));
  const activeTab = tab.id;

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- warms the tab chunk with the query
  useEffect(() => {
    void DASHBOARD_PANELS[activeTab]?.();
  }, [activeTab]);

  const activeDeployment = useQuery(
    api.agent.deployments.getForStage,
    activeStageId ? { projectId: projectId, stageId: activeStageId } : "skip",
  );

  const ensureKey = useMutation(api.agent.deployments.ensureForStage);
  const rotateKey = useMutation(api.agent.deployments.rotate);
  const [generated, setGenerated] = useState<{
    endpointId: string;
    key: string;
  } | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [keyError, setKeyError] = useState<{
    stageId: string;
    msg: string;
  } | null>(null);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const keyDialogWanted = useEverTrue(keyDialogOpen);
  const [keyJustCreated, setKeyJustCreated] = useState(false);

  const stageSession = useStageSession(projectId, activeStageId);
  const revealedKey = useQuery(
    api.agent.deployments.revealKeyForStage,
    activeStageId ? { projectId: projectId, stageId: activeStageId } : "skip",
  );
  const generatedKey =
    generated && generated.endpointId === activeDeployment?.endpointId
      ? generated.key
      : undefined;
  // Session first: core refuses a channel-session continue on the permanent key.
  const observabilityApiKey = stageSession ?? generatedKey;
  const copyableKey = generatedKey ?? revealedKey?.apiKey;
  const currentKeyError =
    keyError && keyError.stageId === activeStageId ? keyError.msg : null;

  const generateViewingKey = useCallback(async () => {
    if (!activeStageId) return;
    void loadRuntimeKeyDialog();
    setGeneratingKey(true);
    setKeyError(null);
    try {
      const result = await ensureKey({
        projectId: projectId,
        stageId: activeStageId,
      });
      if (result.rawApiKey) {
        setGenerated({ endpointId: result.endpointId, key: result.rawApiKey });
        setKeyJustCreated(true);
        setKeyDialogOpen(true);
      } else {
        setKeyError({
          stageId: activeStageId,
          msg: "Couldn't load the key. Try again.",
        });
      }
    } catch (err) {
      setKeyError({
        stageId: activeStageId,
        msg: toErrorMessage(err),
      });
    } finally {
      setGeneratingKey(false);
    }
  }, [activeStageId, projectId, ensureKey]);

  // No catch: the Rotate control shows the rejection inline.
  const rotateViewingKey = useCallback(async () => {
    if (!activeStageId) return;
    const result = await rotateKey({
      projectId: projectId,
      stageId: activeStageId,
    });
    if (result.rawApiKey) {
      setGenerated({ endpointId: result.endpointId, key: result.rawApiKey });
    }
  }, [activeStageId, projectId, rotateKey]);

  const projectSlug = activeDeployment?.projectSlug;
  const stageSlug = activeDeployment?.stageSlug;

  if (project === undefined) return <DashboardLoading />;

  if (project === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Project not found.</p>
      </div>
    );
  }

  const isObservabilityTab =
    activeTab === "monitoring" || activeTab === "tracing";
  const contentMaxWidth =
    activeTab === "billing" || activeTab === "api-key"
      ? "max-w-2xl"
      : isObservabilityTab
        ? "max-w-none"
        : "max-w-7xl";

  const keyResolving =
    Boolean(activeStageId) &&
    stageSession === undefined &&
    !observabilityApiKey;
  const observabilityFallback = keyResolving ? (
    <ObservabilityLoading />
  ) : (
    <ObservabilityKeyPrompt
      generating={generatingKey}
      error={currentKeyError}
      onGenerate={generateViewingKey}
    />
  );

  const renderPanel = (): React.JSX.Element => {
    switch (activeTab) {
      case "monitoring":
        return observabilityApiKey ? (
          <MonitoringPanel
            projectSlug={projectSlug}
            stageSlug={stageSlug}
            apiKey={observabilityApiKey}
          />
        ) : (
          observabilityFallback
        );
      case "tracing":
        return observabilityApiKey ? (
          <TracingPanel
            projectSlug={projectSlug}
            stageSlug={stageSlug}
            apiKey={observabilityApiKey}
          />
        ) : (
          observabilityFallback
        );
      case "usage":
        return (
          <TokensUsagePanel
            projectId={projectId}
            stageId={activeStageId}
            projectSlug={projectSlug}
            stageSlug={stageSlug}
            apiKey={observabilityApiKey ?? undefined}
          />
        );
      case "billing":
        return <BillingPanel projectId={projectId} />;
      case "api-key":
        return copyableKey ? (
          <RuntimeKeyView
            apiKey={copyableKey}
            revealed={revealedKey}
            onRotate={rotateViewingKey}
            projectId={projectId}
            stageId={activeStageId ?? undefined}
            projectSlug={projectSlug}
            stageSlug={stageSlug}
          />
        ) : observabilityApiKey ? (
          <p className="text-sm text-muted-foreground">
            Only an org admin can reveal the runtime key.
          </p>
        ) : (
          observabilityFallback
        );
      default:
        return observabilityApiKey ? (
          <MonitoringPanel
            projectSlug={projectSlug}
            stageSlug={stageSlug}
            apiKey={observabilityApiKey}
          />
        ) : (
          observabilityFallback
        );
    }
  };

  return (
    <div className="flex h-full">
      <div
        className={cn(
          "flex flex-1 flex-col",
          isObservabilityTab ? "overflow-hidden" : "overflow-auto",
        )}
      >
        <h1 className="sr-only">{tab.label}</h1>
        <div
          className={cn(
            "mx-auto w-full",
            contentMaxWidth,
            isObservabilityTab
              ? "flex min-h-0 flex-1 flex-col"
              : "px-6 pt-6 pb-12",
          )}
        >
          {renderPanel()}
        </div>
      </div>

      {copyableKey && keyDialogWanted && (
        <RuntimeKeyDialog
          open={keyDialogOpen}
          onOpenChange={setKeyDialogOpen}
          apiKey={copyableKey}
          justCreated={keyJustCreated}
        />
      )}
    </div>
  );
}
