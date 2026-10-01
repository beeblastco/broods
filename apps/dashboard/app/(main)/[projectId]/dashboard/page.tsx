"use client";

import { useStage } from "@/app/hooks/useStage";
import { useStageSession } from "@/app/hooks/useStageSession";
import { DASHBOARD_TABS, pickTab } from "@/app/lib/navigation";
import { cn } from "@/app/lib/utils";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { BillingPanel } from "./components/BillingPanel";
import { MonitoringPanel } from "./components/MonitoringPanel";
import { ObservabilityKeyPrompt } from "./components/ObservabilityKeyPrompt";
import {
  RuntimeKeyDialog,
  RuntimeKeyView,
} from "./components/RuntimeKeyDialog";
import { TokensUsagePanel } from "./components/TokensUsagePanel";
import { TracingPanel } from "./components/TracingPanel";
import DashboardLoading from "./loading";

export default function DashboardPage(): React.JSX.Element {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId as Id<"projects">;
  // The header already holds the project list, so this answers from the
  // client cache on a navigation instead of waiting one round trip.
  const projects = useQuery(api.project.list, {});
  const project =
    projects === undefined
      ? undefined
      : (projects.find((candidate) => candidate._id === projectId) ?? null);
  const { stageId: activeStageId } = useStage();
  const tab = pickTab(DASHBOARD_TABS, searchParams.get("tab"));
  const activeTab = tab.id;

  // Source of projectSlug, stageSlug and endpointId: the observability WS and
  // the session-storage key lookup are both keyed on them.
  const activeDeployment = useQuery(
    api.agent.deployments.getForStage,
    activeStageId ? { projectId: projectId, stageId: activeStageId } : "skip",
  );

  const ensureKey = useMutation(api.agent.deployments.ensureForStage);
  const rotateKey = useMutation(api.agent.deployments.rotate);
  // A key just minted in this view, scoped to its endpoint so switching
  // stages never serves the wrong stage's key.
  const [generated, setGenerated] = useState<{
    endpointId: string;
    key: string;
  } | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  // Scoped to the stage it occurred in so a stale error never leaks onto another
  // stage after switching.
  const [keyError, setKeyError] = useState<{
    stageId: string;
    msg: string;
  } | null>(null);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [keyJustCreated, setKeyJustCreated] = useState(false);

  // Streaming runs on a short-lived stage session any member can mint; null
  // only when the stage has no deployment yet (the prompt then mints one).
  const stageSession = useStageSession(projectId, activeStageId);
  // The permanent key and its created/last-used metadata; admin-only.
  const revealedKey = useQuery(
    api.agent.deployments.revealKeyForStage,
    activeStageId ? { projectId: projectId, stageId: activeStageId } : "skip",
  );
  const generatedKey =
    generated && generated.endpointId === activeDeployment?.endpointId
      ? generated.key
      : undefined;
  // Ticket first: core refuses the permanent key a channel-session continue.
  const observabilityApiKey = stageSession ?? generatedKey;
  const copyableKey = generatedKey ?? revealedKey?.apiKey;
  const currentKeyError =
    keyError && keyError.stageId === activeStageId ? keyError.msg : null;

  // Mint the stage's runtime key from the dashboard so a dashboard-first user
  // (project created here, never through the CLI) can stream logs/traces. `ensure`
  // creates one on first call and recovers it thereafter.
  const generateViewingKey = useCallback(async () => {
    if (!activeStageId) return;
    setGeneratingKey(true);
    setKeyError(null);
    try {
      const result = await ensureKey({
        projectId: projectId,
        stageId: activeStageId,
      });
      if (result.rawApiKey) {
        setGenerated({ endpointId: result.endpointId, key: result.rawApiKey });
        // Surface the key + SDK usage immediately so a dashboard-first user knows
        // how to wire it into their code, not just that streaming now works.
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
        msg: err instanceof Error ? err.message : "Failed to generate key",
      });
    } finally {
      setGeneratingKey(false);
    }
  }, [activeStageId, projectId, ensureKey]);

  // Surfaces the new plaintext through the same `generated` channel the mint
  // flow uses. The rejection propagates so the Rotate control shows it inline.
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

  // The same skeleton the route's loading.tsx paints, so a client navigation
  // does not flash skeleton → bare text → content.
  if (project === undefined) return <DashboardLoading />;

  if (project === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Project not found.</p>
      </div>
    );
  }

  // Monitoring and tracing are dense, scroll-internally panels that should fill
  // the viewport width and height; billing stays narrow; usage keeps the chart width.
  const isObservabilityTab =
    activeTab === "monitoring" || activeTab === "tracing";
  const contentMaxWidth =
    activeTab === "billing" || activeTab === "api-key"
      ? "max-w-2xl"
      : isObservabilityTab
        ? "max-w-none"
        : "max-w-7xl";

  // While the reveal query is still resolving, hold a quiet loader instead of
  // flashing the "generate a key" prompt. That prompt is only the true-absence state.
  const keyResolving =
    Boolean(activeStageId) &&
    stageSession === undefined &&
    !observabilityApiKey;
  const observabilityFallback = keyResolving ? (
    <div className="flex h-full min-h-64 items-center justify-center">
      <p className="text-sm text-muted-foreground">Loading…</p>
    </div>
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
      {/* Content area: observability tabs own their internal scroll and fill
          the height; other tabs scroll the whole column. */}
      <div
        className={cn(
          "flex flex-1 flex-col",
          isObservabilityTab ? "overflow-hidden" : "overflow-auto",
        )}
      >
        <h1 className="sr-only">{tab.label}</h1>
        <div
          className={cn(
            "mx-auto w-full px-6 pt-6",
            contentMaxWidth,
            isObservabilityTab ? "flex min-h-0 flex-1 flex-col pb-6" : "pb-12",
          )}
        >
          {renderPanel()}
        </div>
      </div>

      {copyableKey && (
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
